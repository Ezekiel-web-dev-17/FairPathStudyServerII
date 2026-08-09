# Comprehensive Guide to Jest Testing

Jest is a feature-rich JavaScript and TypeScript testing framework designed with a focus on simplicity, speed, and developer experience. It is the default testing framework included in **NestJS** applications.

---

## 1. Core Structure & Test Suites

Jest organizes tests using block functions:

- `describe(name, fn)`: Groups related test cases into a test suite.
- `it(name, fn)` or `test(name, fn)`: Defines an individual test case.
- `expect(value)`: Wraps an actual value to run assertion checks against expected outcomes.

```typescript
describe('CalculatorService', () => {
  it('should add two numbers correctly', () => {
    const result = 2 + 3;
    expect(result).toBe(5);
  });
});
```

---

## 2. Test Lifecycle Hooks

Jest provides lifecycle hooks to execute code before or after tests run:

| Hook | Execution Timing | Typical Usage |
| :--- | :--- | :--- |
| `beforeAll(fn)` | Runs once **before** any test in the file/suite runs | Setting up test databases, seeding static data |
| `beforeEach(fn)`| Runs **before each** individual test | Resetting test state, creating fresh module instances |
| `afterEach(fn)` | Runs **after each** individual test | Clearing mocks (`jest.clearAllMocks()`), cleaning up spies |
| `afterAll(fn)`  | Runs once **after** all tests in the file/suite complete | Closing database connections, shutting down servers |

```typescript
describe('Database Operation Suite', () => {
  beforeAll(async () => {
    // Connect to test database
  });

  afterEach(() => {
    jest.clearAllMocks(); // Recommended: avoid state leakage between tests
  });

  afterAll(async () => {
    // Disconnect database
  });
});
```

---

## 3. Key Jest Matchers

Matchers allow you to test values in different ways:

### Equality & Truthiness
- `toBe(value)`: Exact equality check using `Object.is` (primitive values).
- `toEqual(value)`: Deep equality check (objects and arrays).
- `toBeTruthy()` / `toBeFalsy()`: Checks if a value evaluates to `true` or `false` in a boolean context.
- `toBeNull()` / `toBeUndefined()` / `toBeDefined()`: Value existence checks.

### Numbers & Strings
- `toBeGreaterThan(n)` / `toBeLessThan(n)`: Numeric comparisons.
- `toBeCloseTo(number, numDigits)`: Floating-point number comparisons.
- `toMatch(regexpOrString)`: Checks if a string matches a regular expression.

### Arrays & Objects
- `toContain(item)`: Checks if an array contains an item or a substring is inside a string.
- `toHaveProperty(keyPath, value?)`: Checks if an object has a specific property.
- `objectContaining(object)`: Partial object matching.

### Exceptions
- `toThrow(error?)`: Verifies that a function throws an error when invoked.

```typescript
it('demonstrates common matchers', () => {
  const user = { name: 'Alice', age: 30, roles: ['admin', 'user'] };

  expect(user.name).toBe('Alice');
  expect(user).toEqual({ name: 'Alice', age: 30, roles: ['admin', 'user'] });
  expect(user.roles).toContain('admin');
  expect(user).toHaveProperty('age', 30);
  expect(() => { throw new Error('Unauthorized'); }).toThrow('Unauthorized');
});
```

---

## 4. Mocking in Jest

Mocking isolates code under test by replacing real dependencies with controllable implementations.

### 4.1 Mock Functions (`jest.fn()`)
```typescript
const mockCallback = jest.fn((x: number) => x + 42);

mockCallback(1);
mockCallback(2);

expect(mockCallback).toHaveBeenCalledTimes(2);
expect(mockCallback).toHaveBeenNthCalledWith(1, 1);
expect(mockCallback.mock.results[0].value).toBe(43);
```

### 4.2 Spying on Methods (`jest.spyOn()`)
`jest.spyOn()` wraps existing object methods to track calls or override behavior while retaining the option to restore original implementations.

```typescript
const userService = {
  getUser: (id: string) => ({ id, name: 'John' }),
};

const spy = jest.spyOn(userService, 'getUser').mockReturnValue({ id: '1', name: 'Mocked John' });

const result = userService.getUser('1');
expect(result.name).toBe('Mocked John');
expect(spy).toHaveBeenCalledWith('1');

spy.mockRestore(); // Restores original implementation
```

### 4.3 Mock Return Values
- `mockReturnValue(value)` / `mockReturnValueOnce(value)`
- `mockResolvedValue(value)` / `mockResolvedValueOnce(value)` *(for Promises)*
- `mockRejectedValue(error)` *(for Promise rejections)*

```typescript
const fetchUserMock = jest.fn();
fetchUserMock.mockResolvedValue({ id: '123', name: 'Ezekiel' });

const user = await fetchUserMock();
expect(user.name).toBe('Ezekiel');
```

---

## 5. Testing Asynchronous Code

Jest handles asynchronous operations seamlessly using `async/await` or promise matchers.

### Using `async/await`
```typescript
it('fetches data asynchronously', async () => {
  const data = await fetchData();
  expect(data).toBe('success');
});
```

### Testing Promise Rejections
```typescript
it('handles async errors correctly', async () => {
  await expect(fetchDataWithFailure()).rejects.toThrow('Network Error');
});
```

---

## 6. Jest in NestJS Applications

NestJS provides `@nestjs/testing` to create isolated testing modules for services and controllers.

### 6.1 Unit Testing a Service
Suppose we have `AppService`:

```typescript
// src/app.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';

describe('AppService', () => {
  let service: AppService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    }).compile();

    service = module.get<AppService>(AppService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return "Hello World!"', () => {
    expect(service.getHello()).toBe('Hello World!');
  });
});
```

### 6.2 Unit Testing a Controller with Mocks
When testing a Controller, mock its injected Services:

```typescript
// src/app.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let controller: AppController;
  let service: AppService;

  beforeEach(async () => {
    const mockAppService = {
      getHello: jest.fn().mockReturnValue('Hello from Mock!'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: mockAppService, // Substitute real service with mock object
        },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
    service = module.get<AppService>(AppService);
  });

  it('should return mock message', () => {
    expect(controller.getHello()).toBe('Hello from Mock!');
    expect(service.getHello).toHaveBeenCalled();
  });
});
```

### 6.3 End-to-End (E2E) Testing in NestJS
E2E tests spin up the full NestJS application HTTP server and use `supertest` to make actual API calls:

```typescript
// test/app.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
```

---

## 7. Useful Jest CLI Commands

You can run test scripts defined in [package.json](file:///wsl.localhost/Ubuntu-24.04/home/ezekiel/projects/fair-path-server-ii/package.json):

```bash
# Run all unit tests once
npm run test

# Run tests in watch mode (re-runs on file save)
npm run test:watch

# Generate code coverage report
npm run test:cov

# Run specific test file
npx jest src/app.controller.spec.ts

# Run End-to-End (E2E) tests
npm run test:e2e
```

---

## 8. Best Practices for Jest Testing

> [!TIP]
> **Follow the AAA Pattern (Arrange, Act, Assert)**
> - **Arrange**: Set up test data, mocks, and module dependencies.
> - **Act**: Invoke the target method or function.
> - **Assert**: Verify expected outcomes with `expect()`.

> [!IMPORTANT]
> **Keep Tests Isolated & Deterministic**
> Clear mock histories between tests with `jest.clearAllMocks()` in `afterEach()` or enable `clearMocks: true` in your `jest.config.js`. Avoid relying on global mutable state across test cases.

> [!NOTE]
> **Test Behavior, Not Implementation Details**
> Focus assertions on output values and side effects rather than internal implementation steps to keep tests resilient to code refactoring.
