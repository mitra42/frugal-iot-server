export default {
  testEnvironment: 'node',
  testMatch: ['test/**/*.test.js'],
  testPathIgnorePatterns: [],
  collectCoverageFrom: [
    'lib/**/*.js',
    'frugal-iot-server.js'
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/'
  ]
};

