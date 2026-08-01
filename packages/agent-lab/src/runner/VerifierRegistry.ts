import type { Verifier } from "../protocol/index.js";

export class VerifierRegistry {
  private readonly verifiers = new Map<string, Verifier>();

  public register(id: string, verifier: Verifier): void {
    if (!id.trim()) throw new Error("Verifier id cannot be blank");
    if (this.verifiers.has(id))
      throw new Error(`Verifier already registered: ${id}`);
    this.verifiers.set(id, verifier);
  }

  public get(id: string): Verifier | null {
    return this.verifiers.get(id) ?? null;
  }

  public ids(): readonly string[] {
    return [...this.verifiers.keys()].sort();
  }
}
