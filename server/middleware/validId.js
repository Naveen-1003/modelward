// router.param handler: reject malformed ObjectIds with 400 instead of letting
// Mongoose throw a CastError that surfaces as a 500.
module.exports = function validId(req, res, next, id) {
  if (!/^[a-f\d]{24}$/i.test(id)) return res.status(400).json({ error: "Invalid id" });
  next();
};
