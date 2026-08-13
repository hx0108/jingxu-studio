export class PersistenceRuntimeError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'PersistenceRuntimeError';
  }
}
