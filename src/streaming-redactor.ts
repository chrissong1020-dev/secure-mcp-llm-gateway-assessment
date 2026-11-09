const EMAIL = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/gi;
const SSN = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Redacts complete values immediately and keeps only the unfinished token at the
 * end of a chunk. That small carry is what lets `alice@exam` + `ple.com` work
 * without buffering the whole model response.
 */
export class StreamingRedactor {
  private carry = "";
  private readonly maxCarry = 320;

  push(text: string): string {
    const combined = this.carry + text;
    const cut = findStableCut(combined);
    const stable = combined.slice(0, cut);
    this.carry = combined.slice(cut);

    // Bound memory even for a deliberately huge, delimiter-free token.
    if (this.carry.length > this.maxCarry) {
      const overflow = this.carry.slice(0, -this.maxCarry);
      this.carry = this.carry.slice(-this.maxCarry);
      return redact(stable) + redact(overflow);
    }
    return redact(stable);
  }

  flush(): string {
    const output = redact(this.carry);
    this.carry = "";
    return output;
  }
}

export function redact(text: string): string {
  return text
    .replace(EMAIL, "[REDACTED]")
    .replace(SSN, "[REDACTED]")
    .replace(CARD_CANDIDATE, (candidate) =>
      passesLuhn(candidate) ? "[REDACTED]" : candidate,
    );
}

function findStableCut(text: string): number {
  let cut = text.length;

  // An email can be split anywhere inside its final token.
  const emailTail =
    text.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*@[A-Za-z0-9.-]*$/) ??
    text.match(
      /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]$/,
    );
  if (emailTail?.index !== undefined) cut = Math.min(cut, emailTail.index);

  // Cards and SSNs commonly contain spaces or hyphens, so keep a trailing
  // numeric run as well. The cap covers a 19-digit card plus separators.
  const numericTail = text.match(/\d(?:[ -]?\d){0,18}[ -]?$/);
  if (numericTail?.index !== undefined) cut = Math.min(cut, numericTail.index);

  return cut;
}

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (doubleDigit) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}
