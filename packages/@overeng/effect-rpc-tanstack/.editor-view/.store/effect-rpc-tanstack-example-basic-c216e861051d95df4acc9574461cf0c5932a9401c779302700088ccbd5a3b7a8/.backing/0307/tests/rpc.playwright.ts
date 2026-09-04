import { expect, test } from '@playwright/test'
import { Effect } from 'effect'

import * as Pw from '@overeng/utils/node/playwright'

test.describe('Effect RPC + TanStack Start', () => {
  test('loads initial users from server', ({ page, context }) =>
    Pw.withTestCtx({ page, context })(
      Effect.gen(function* () {
        yield* Pw.Page.goto({ url: '/' })

        const userList = yield* Pw.Locator.getByTestId('user-list')
        yield* Pw.Locator.waitFor({ locator: userList })

        const user1 = yield* Pw.Locator.getByTestId('user-1')
        yield* Pw.expect(
          'user-1-contains-alice',
          expect(yield* Pw.Locator.textContent({ locator: user1 })).toContain('Alice'),
        )

        const user2 = yield* Pw.Locator.getByTestId('user-2')
        yield* Pw.expect(
          'user-2-contains-bob',
          expect(yield* Pw.Locator.textContent({ locator: user2 })).toContain('Bob'),
        )
      }),
    ))

  test('creates a new user via RPC', ({ page, context }) =>
    Pw.withTestCtx({ page, context })(
      Effect.gen(function* () {
        yield* Pw.Page.goto({ url: '/' })

        const nameInput = yield* Pw.Locator.getByTestId('name-input')
        yield* Pw.Locator.fill({ locator: nameInput, value: 'Charlie' })

        const emailInput = yield* Pw.Locator.getByTestId('email-input')
        yield* Pw.Locator.fill({
          locator: emailInput,
          value: 'charlie@example.com',
        })

        const submitButton = yield* Pw.Locator.getByTestId('submit-button')
        yield* Pw.Locator.click({ locator: submitButton })

        const user3 = yield* Pw.Locator.getByTestId('user-3')
        yield* Pw.Locator.waitFor({ locator: user3 })

        const user3Text = yield* Pw.Locator.textContent({ locator: user3 })
        yield* Pw.expect('user-3-contains-charlie', expect(user3Text).toContain('Charlie'))
        yield* Pw.expect(
          'user-3-contains-email',
          expect(user3Text).toContain('charlie@example.com'),
        )
      }),
    ))

  test('navigates to user detail page', ({ page, context }) =>
    Pw.withTestCtx({ page, context })(
      Effect.gen(function* () {
        yield* Pw.Page.goto({ url: '/users/1' })

        const userId = yield* Pw.Locator.getByTestId('user-id')
        yield* Pw.expect(
          'user-id-is-1',
          expect(yield* Pw.Locator.textContent({ locator: userId })).toBe('1'),
        )

        const userName = yield* Pw.Locator.getByTestId('user-name')
        yield* Pw.expect(
          'user-name-is-alice',
          expect(yield* Pw.Locator.textContent({ locator: userName })).toBe('Alice'),
        )

        const userEmail = yield* Pw.Locator.getByTestId('user-email')
        yield* Pw.expect(
          'user-email-is-correct',
          expect(yield* Pw.Locator.textContent({ locator: userEmail })).toBe('alice@example.com'),
        )
      }),
    ))

  test('handles user not found error', ({ page, context }) =>
    Pw.withTestCtx({ page, context })(
      Effect.gen(function* () {
        yield* Pw.Page.goto({ url: '/users/999' })

        const errorText = yield* Pw.Locator.getByText('User not found: 999')
        yield* Pw.Locator.waitFor({ locator: errorText })
      }),
    ))
})
