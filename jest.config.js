/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  moduleNameMapper: {
    '^@earendil-works/pi-coding-agent$': '<rootDir>/test/__mocks__/@earendil-works/pi-coding-agent.ts',
    '^@earendil-works/pi-tui$': '<rootDir>/test/__mocks__/@earendil-works/pi-tui.ts',
    '^typebox$': '<rootDir>/test/__mocks__/typebox.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          types: ['jest', 'node'],
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleDirectories: ['node_modules'],
};
