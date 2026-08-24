# Backend Test Suite

## Overview
Comprehensive unit test suite for the employee time tracking backend API. Tests cover all routes, middleware, database operations, and validation logic.

## Quick Start

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run in watch mode (for development)
npm run test:watch

# Run with detailed output
npm run test:verbose

# Run for CI/CD (with coverage enforcement)
npm run test:ci

# View HTML coverage report
npm run test:coverage:html
```

## Test Structure

```
__tests__/
├── setup.js                    # Global test configuration
│
├── database/
│   └── init.test.js           # Database initialization tests
│
├── middleware/
│   ├── auth.test.js           # Authentication middleware
│   └── errorHandler.test.js   # Error handling middleware
│
├── routes/
│   ├── auth.test.js           # Auth endpoints
│   ├── clients.test.js        # Client CRUD operations
│   ├── reports.test.js        # Report generation
│   └── workEntries.test.js    # Work entry CRUD operations
│
└── validation/
    └── schemas.test.js        # Joi validation schemas
```

## Coverage Summary

| Module | Coverage | Tests |
|--------|----------|-------|
| Database | 93.1% | 8 |
| Middleware | 100% | 19 |
| Routes | 75.9% | 76 |
| Validation | 100% | 38 |
| **Total** | **79.2%** | **134** |

## Test Categories

### Authentication Tests (22 tests)
- Email validation and format checking
- User creation and authentication
- Header-based authentication
- Database error handling

### CRUD Operation Tests (48 tests)
- Client management (24 tests)
- Work entry management (24 tests)
- Input validation
- Authorization checks
- Error scenarios

### Validation Tests (38 tests)
- Client schema validation
- Work entry schema validation
- Update schema validation
- Email schema validation
- Edge cases and boundary conditions

### Report Tests (17 tests)
- Report generation
- Hours aggregation
- Data isolation
- Export validation (CSV/PDF)

### Error Handling Tests (19 tests)
- Joi validation errors
- SQLite database errors
- Generic error responses
- Status code handling

## Writing New Tests

### Test Template
```javascript
const request = require('supertest');
const express = require('express');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

describe('Feature Name', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should do something', async () => {
    // Arrange
    mockDb.get.mockImplementation((query, params, callback) => {
      callback(null, { id: 1 });
    });

    // Act
    const response = await request(app).get('/api/endpoint');

    // Assert
    expect(response.status).toBe(200);
  });
});
```

### Best Practices

1. **Use descriptive test names**
   ```javascript
   ✅ test('should return 404 if client not found')
   ❌ test('test client route')
   ```

2. **Follow AAA pattern**
   - Arrange: Set up test data and mocks
   - Act: Execute the code being tested
   - Assert: Verify the results

3. **Mock external dependencies**
   ```javascript
   jest.mock('../../database/init');
   jest.mock('../../middleware/auth');
   ```

4. **Test error scenarios**
   ```javascript
   test('should handle database error', async () => {
     mockDb.get.mockImplementation((query, params, callback) => {
       callback(new Error('Database error'), null);
     });
     // ... test error response
   });
   ```

5. **Keep tests isolated**
   - Use `beforeEach` and `afterEach`
   - Clear mocks between tests
   - Don't rely on test execution order

## Mocking Strategy

### Database Mocking
```javascript
mockDb = {
  all: jest.fn(),   // For SELECT queries returning multiple rows
  get: jest.fn(),   // For SELECT queries returning single row
  run: jest.fn()    // For INSERT, UPDATE, DELETE
};
```

### Authentication Mocking
```javascript
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    next();
  }
}));
```

### File System Mocking
```javascript
jest.mock('fs');
fs.existsSync = jest.fn().mockReturnValue(true);
fs.mkdirSync = jest.fn();
```

## Common Test Patterns

### Testing CRUD Operations
```javascript
// GET all
test('should return all items', async () => {
  mockDb.all.mockImplementation((query, params, callback) => {
    callback(null, [{ id: 1 }, { id: 2 }]);
  });
  const response = await request(app).get('/api/items');
  expect(response.status).toBe(200);
  expect(response.body.items).toHaveLength(2);
});

// POST create
test('should create new item', async () => {
  mockDb.run.mockImplementation(function(query, params, callback) {
    this.lastID = 1;
    callback.call(this, null);
  });
  const response = await request(app)
    .post('/api/items')
    .send({ name: 'Test' });
  expect(response.status).toBe(201);
});
```

### Testing Validation
```javascript
test('should reject invalid input', async () => {
  const response = await request(app)
    .post('/api/items')
    .send({ invalid: 'data' });
  expect(response.status).toBe(400);
});
```

### Testing Authorization
```javascript
test('should only return user-owned data', async () => {
  mockDb.all.mockImplementation((query, params, callback) => {
    expect(params).toContain('test@example.com');
    callback(null, []);
  });
  await request(app).get('/api/items');
});
```

## Debugging Tests

### Run specific test file
```bash
npm test -- auth.test.js
```

### Run specific test
```bash
npm test -- -t "should create new client"
```

### Run with console output
```bash
npm test -- --verbose
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Jest Debug",
  "program": "${workspaceFolder}/node_modules/.bin/jest",
  "args": ["--runInBand", "--no-cache"],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

## Coverage Goals

- **Statements**: > 60% (Current: 79.2%)
- **Branches**: > 60% (Current: 80.3%)
- **Functions**: > 65% (Current: 89.1%)
- **Lines**: > 60% (Current: 79.3%)

## CI/CD Integration

### GitHub Actions Example
```yaml
- name: Run tests
  run: npm run test:ci

- name: Upload coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
```

## Troubleshooting

### Tests timing out
- Increase timeout in `jest.config.js`
- Check for unresolved promises
- Ensure callbacks are called in mocks

### Mocks not working
- Check mock is defined before import
- Use `jest.clearAllMocks()` in `afterEach`
- Verify mock path is correct

### Coverage not accurate
- Check `collectCoverageFrom` in `jest.config.js`
- Ensure all files are included
- Run `npm test -- --coverage --verbose`

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [Testing Best Practices](https://testingjavascript.com/)
