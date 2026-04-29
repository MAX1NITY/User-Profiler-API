const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, 
    message: { status: "error", message: "Too many login attempts, please try again later" }
});

const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60,
    message: { status: "error", message: "Rate limit exceeded" }
});

module.exports = { authLimiter, generalLimiter };