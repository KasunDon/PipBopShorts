/** A caller mistake (bad parameter, wrong state for the operation) → HTTP 400. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}
