const { z } = require("zod");

// Validate req.body / req.query against a zod schema.
//   const data = parse(schema, req.body, res);   // sends the 400 itself
//   if (!data) return;
// Responds { error: "<first problem>", fields: { fieldName: "message" } }.
function parse(schema, input, res) {
  const result = schema.safeParse(input === undefined ? {} : input);
  if (result.success) return result.data;

  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    if (!fields[key]) fields[key] = issue.message;
  }
  const [firstKey, firstMsg] = Object.entries(fields)[0];
  res.status(400).json({
    error: firstKey === "_" ? firstMsg : `${firstKey}: ${firstMsg}`,
    fields,
  });
  return null;
}

// Strict string: rejects objects/arrays/numbers (the {"$gt":""} class of input),
// trims, and enforces length.
const str = (max, { min = 0 } = {}) => z.string({ invalid_type_error: "must be a string", required_error: "is required" }).trim().min(min, min ? `must be at least ${min} character(s)` : undefined).max(max, `must be at most ${max} characters`);

const requiredStr = (max) => str(max, { min: 1 });

module.exports = { parse, z, str, requiredStr };
