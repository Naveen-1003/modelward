const { z } = require("../middleware/validate");

// Strict pagination query fields for zod: "abc", "0", "-3", "1.5" are 400s (never
// silently coerced); a limit above 100 is clamped to 100.
const MAX_LIMIT = 100;
const positiveInt = (msg) => z.string({ invalid_type_error: msg }).regex(/^[1-9]\d{0,8}$/, msg);

const paginationFields = {
  page: positiveInt("must be a positive integer").transform(Number).optional(),
  limit: positiveInt("must be a positive integer").transform((n) => Math.min(Number(n), MAX_LIMIT)).optional(),
};

// Resolve parsed page/limit into skip/limit numbers.
function pageWindow(q, defaultLimit) {
  const page = q.page || 1;
  const limit = q.limit || defaultLimit;
  return { page, limit, skip: (page - 1) * limit };
}

const envelope = (items, key, { page, limit }, total) => ({
  [key]: items,
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { paginationFields, pageWindow, envelope, escapeRegex, MAX_LIMIT };
