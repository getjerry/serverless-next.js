const DEBUG = true;

export function debug(message: string): void {
  if (!DEBUG) {
    return;
  }

  console.log(message);
}
