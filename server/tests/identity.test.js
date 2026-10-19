const crypto = require("crypto");
const id = require("../utils/identity");

describe("normalizeEmail", () => {
  test("lowercases, trims and strips the +tag from the local part", () => {
    expect(id.normalizeEmail("Jo+hr@Acme.com")).toBe("jo@acme.com");
    expect(id.normalizeEmail("  JO@ACME.COM \n")).toBe("jo@acme.com");
    expect(id.normalizeEmail("a+b+c@x.com")).toBe("a@x.com");
    expect(id.normalizeEmail("a+@x.com")).toBe("a@x.com");
  });

  test("keeps everything else: dots, domain, subdomains", () => {
    expect(id.normalizeEmail("j.o@x.com")).toBe("j.o@x.com");
    expect(id.normalizeEmail("a@Mail.Acme.com")).toBe("a@mail.acme.com");
    expect(id.normalizeEmail("a+tag@mail.acme.com")).toBe("a@mail.acme.com");
  });

  test("odd inputs never throw and give strings", () => {
    expect(id.normalizeEmail(null)).toBe("");
    expect(id.normalizeEmail(undefined)).toBe("");
    expect(id.normalizeEmail("")).toBe("");
    expect(id.normalizeEmail(42)).toBe("42");
    expect(id.normalizeEmail("no-at-sign")).toBe("no-at-sign");
    expect(id.normalizeEmail("+x@acme.com")).toBe("+x@acme.com"); // empty base would collide, so left alone
    expect(id.normalizeEmail("@acme.com")).toBe("@acme.com");
    expect(typeof id.normalizeEmail({ $gt: "" })).toBe("string");
    expect(typeof id.normalizeEmail(["a+b@x.com"])).toBe("string");
  });

  test("the last @ splits, so a tag cannot hide a different domain", () => {
    expect(id.normalizeEmail("a+b@evil.com@acme.com")).toBe("a@acme.com");
    expect(id.normalizeEmail("a@acme.com+b@evil.com")).toBe("a@acme.com@evil.com");
  });

  test("two spellings of one mailbox share a key", () => {
    expect(id.normalizeEmail("Ann+Work@Acme.com")).toBe(id.normalizeEmail("ann@acme.com"));
    expect(id.normalizeEmail("ann+1@acme.com")).toBe(id.normalizeEmail("ann+2@acme.com"));
  });
});

describe("emailDomain", () => {
  test("text after the last @, lowercased", () => {
    expect(id.emailDomain("A@Acme.COM")).toBe("acme.com");
    expect(id.emailDomain("a@b@acme.com")).toBe("acme.com");
    expect(id.emailDomain("nodomain")).toBe("");
    expect(id.emailDomain(null)).toBe("");
    expect(id.emailDomain("a@")).toBe("");
  });
});

describe("normalizeDomain", () => {
  test("accepts plausible hostnames and normalizes them", () => {
    expect(id.normalizeDomain("  @Acme.com ")).toBe("acme.com");
    expect(id.normalizeDomain("acme.com")).toBe("acme.com");
    expect(id.normalizeDomain("Mail.Acme.CO.UK")).toBe("mail.acme.co.uk");
    expect(id.normalizeDomain("xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
    expect(id.normalizeDomain(`${"a".repeat(63)}.com`)).toBe(`${"a".repeat(63)}.com`);
  });

  test("rejects everything else", () => {
    const bad = [
      "", "   ", "acme", "localhost", "acme.c", "acme.com.", "-acme.com", "acme-.com", "acme..com", ".acme.com", "a b.com",
      "https://acme.com", "acme.com/path", "acme.com:8080", "user@acme.com", "*.acme.com", "1.2.3.4", "acme.c0m", "acme.com,evil.com",
      "acmе.com", "ａcme.com", "acme。com", "acme.com​", "acme.com\u0000", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`,
    ];
    for (const d of bad) expect(id.normalizeDomain(d)).toBeNull();
    expect(id.normalizeDomain(null)).toBeNull();
    expect(id.normalizeDomain(undefined)).toBeNull();
    expect(id.normalizeDomain({})).toBeNull();
    expect(id.normalizeDomain(["acme.com", "evil.com"])).toBeNull();
  });
});

describe("domainAllowed (exact match only)", () => {
  const org = { domainRuleEnabled: true, allowedDomains: ["acme.com", "acme.co.uk"] };

  test("allows exact domains, case-insensitively", () => {
    expect(id.domainAllowed(org, "ann@acme.com")).toBe(true);
    expect(id.domainAllowed(org, "ANN@ACME.COM")).toBe(true);
    expect(id.domainAllowed(org, "ann@Acme.Co.Uk")).toBe(true);
    expect(id.domainAllowed(org, "ann+tag@acme.com")).toBe(true);
    expect(id.domainAllowed(org, "evil.com@acme.com")).toBe(true); // the domain is what follows the last @
  });

  test.each([
    ["suffix attack", "ann@acme.com.evil.com"],
    ["subdomain", "ann@sub.acme.com"],
    ["subdomain of second entry", "ann@mail.acme.co.uk"],
    ["prefix attack", "ann@evilacme.com"],
    ["other tld", "ann@acme.org"],
    ["trailing dot", "ann@acme.com."],
    ["trailing space", "ann@acme.com "],
    ["trailing newline", "ann@acme.com\n"],
    ["second @ trick", "ann@acme.com@evil.com"],
    ["encoded @", "ann%40acme.com@evil.com"],
    ["display-name trick", "acme.com <ann@evil.com>"],
    ["comma list", "ann@acme.com,ann@evil.com"],
    ["no domain", "ann"],
    ["empty domain", "ann@"],
    ["empty", ""],
    ["cyrillic e lookalike", "ann@acmе.com"],
    ["cyrillic a lookalike", "ann@аcme.com"],
    ["fullwidth letter", "ann@ａcme.com"],
    ["zero width space", "ann@acme.com​"],
    ["ideographic full stop", "ann@acme。com"],
    ["null byte", "ann@acme.com\u0000.evil.com"],
    ["punycode lookalike", "ann@xn--acm-9ze.com"],
  ])("rejects %s", (_name, email) => {
    expect(id.domainAllowed(org, email)).toBe(false);
  });

  test("rejects non-string and missing values (fails closed)", () => {
    expect(id.domainAllowed(org, undefined)).toBe(false);
    expect(id.domainAllowed(org, null)).toBe(false);
    expect(id.domainAllowed(org, { $ne: "" })).toBe(false);
    expect(id.domainAllowed({ domainRuleEnabled: true, allowedDomains: [] }, "ann@acme.com")).toBe(false);
    expect(id.domainAllowed({ domainRuleEnabled: true }, "ann@acme.com")).toBe(false);
  });

  test("with the rule off every address passes", () => {
    const open = { domainRuleEnabled: false, allowedDomains: ["acme.com"] };
    expect(id.domainAllowed(open, "ann@gmail.com")).toBe(true);
    expect(id.domainAllowed(open, "ann@acme.com.evil.com")).toBe(true);
  });
});

describe("FREE_MAIL_DOMAINS", () => {
  test("contains the usual public providers and not company domains", () => {
    for (const d of ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "aol.com", "live.com"]) {
      expect(id.FREE_MAIL_DOMAINS.has(d)).toBe(true);
    }
    expect(id.FREE_MAIL_DOMAINS.has("acme.com")).toBe(false);
    expect(id.FREE_MAIL_DOMAINS.has("GMAIL.COM")).toBe(false); // callers normalize first
  });

  test("every entry is already a normalized, valid domain", () => {
    for (const d of id.FREE_MAIL_DOMAINS) expect(id.normalizeDomain(d)).toBe(d);
  });

  test("normalizing a spelled-up free-mail domain still hits the set", () => {
    expect(id.FREE_MAIL_DOMAINS.has(id.normalizeDomain(" @Gmail.COM "))).toBe(true);
  });
});

describe("newToken / hashToken", () => {
  test("token is 64 hex chars of randomness; hash is its sha256 and differs from it", () => {
    const { token, hash } = id.newToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(id.hashToken(token)).toBe(hash);
  });

  test("tokens are unique", () => {
    const set = new Set();
    for (let i = 0; i < 500; i += 1) set.add(id.newToken().token);
    expect(set.size).toBe(500);
  });

  test("hashToken is deterministic and case/whitespace sensitive; non-strings hash like the empty string", () => {
    const { token } = id.newToken();
    expect(id.hashToken(token)).toBe(id.hashToken(token));
    expect(id.hashToken(token.toUpperCase())).not.toBe(id.hashToken(token));
    expect(id.hashToken(` ${token}`)).not.toBe(id.hashToken(token));
    const empty = id.hashToken("");
    for (const v of [undefined, null, 5, {}, [token], { $ne: "" }]) expect(id.hashToken(v)).toBe(empty);
    expect(id.hashToken([token])).not.toBe(id.hashToken(token)); // an array cannot smuggle a real token
  });
});
