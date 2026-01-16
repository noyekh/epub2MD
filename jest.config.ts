import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'mjs'],
  testTimeout: 60000, // 60 seconds for CLI tests
};

export default config;