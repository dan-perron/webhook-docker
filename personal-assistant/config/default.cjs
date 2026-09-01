const config = {
  mongodb: {
    connectionString: process.env.MONGODB_CONNSTRING,
  },
  slack: {
    appToken: null,
    signingSecret: null,
    token: null,
  },
  targetUserId: null,
};
module.exports = config;
