import { ModelRequestClient, type ModelRequestObjectInput } from '@velaros-ai/model'

interface Account {
  id: string
  retries: number
}

// Standard Schema is structural; this fixture stays independent of any validator package.
const AccountSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'velaros-packed-fixture',
    validate: (_value: unknown) => ({
      value: { id: 'packed-account', retries: 2 } satisfies Account,
    }),
  },
}

declare const client: ModelRequestClient

const request = {
  endpoint: 'fixture.structured-output',
  model: 'fixture-model',
  system: 'Return the fixture account.',
  messages: [{ role: 'user' as const, content: 'account' }],
  schemaName: 'FixtureAccount',
  schemaDescription: 'A typed fixture account.',
}

const inferred = client.generateObject({
  ...request,
  schema: AccountSchema,
})
const explicit = client.generateObject<Account>({
  ...request,
  schema: AccountSchema,
})
const decoded = client.generateDecodedObject({
  ...request,
  schema: AccountSchema,
  decodeOutput: (output) => `${output.id}:${output.retries}`,
})

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false
type Expect<T extends true> = T

type _InferredFromSchema = Expect<
  Equal<Awaited<typeof inferred>, Account>
>
type _ExplicitSchemaContract = Expect<Equal<Awaited<typeof explicit>, Account>>
type _DecodedFromSchema = Expect<Equal<Awaited<typeof decoded>, string>>

const invalidRequest: ModelRequestObjectInput<{ id: number; retries: number }> = {
  ...request,
  // @ts-expect-error schema output id:string cannot be detached from id:number
  schema: AccountSchema,
}

void invalidRequest
void (null as unknown as _InferredFromSchema)
void (null as unknown as _ExplicitSchemaContract)
void (null as unknown as _DecodedFromSchema)
