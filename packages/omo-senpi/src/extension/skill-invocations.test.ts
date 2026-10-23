import { expect, test } from "bun:test"

import { explicitSkillInvocations } from "./skill-invocations"

test("parses leading chained skills and explicit inline tokens without consuming ordinary dollar prose", () => {
  // Given the host's supported syntax and ordinary inline variables.
  const text = "  /skill:ulw-plan\t$skill:ultrawork $mass-ulw fix $HOME with $skill:ulw-loop"

  // When the adapter observes invocations before native expansion.
  const tokens = explicitSkillInvocations(text)

  // Then only executable skill tokens are returned with their exact boundaries.
  expect(tokens.map((token) => token.name)).toEqual(["ulw-plan", "ultrawork", "mass-ulw", "ulw-loop"])
  expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual([
    "/skill:ulw-plan", "$skill:ultrawork", "$mass-ulw", "$skill:ulw-loop",
  ])
})

test.each(["plain $HOME", "literal $ulw-plan", "/skill:ulw-plan,", "$skill:"])("does not treat %s as an executable skill token", (text) => {
  // Given syntax that the host leaves literal.
  // When the adapter parses it.
  const tokens = explicitSkillInvocations(text)
  // Then no invocation is recorded.
  expect(tokens).toEqual([])
})
