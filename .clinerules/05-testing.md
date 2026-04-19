# Testing Rules

- Vitest with globals (describe, it, expect — no imports)
- In-memory SQLite for all DB tests (`:memory:`)
- Co-located: __tests__/*.test.ts or *.test.ts
- Use Brain class directly for integration tests
- Each test creates its own Brain instance
- No SQLite mocking — use real in-memory DB
- Test happy path + error cases
- Run: pnpm test (all) or cd packages/core && pnpm test (single)
