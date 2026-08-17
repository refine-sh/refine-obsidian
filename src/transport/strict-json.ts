export class StrictJSONError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJSONError";
  }
}

const numberLexemes = new WeakMap<object, Map<string | number, string>>();

export function parseJSON(text: string): unknown {
  return new JSONParser(text).parse();
}

export function parseJSONObject(text: string): Record<string, unknown> {
  const value = parseJSON(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StrictJSONError("JSON root must be an object");
  }
  return value as Record<string, unknown>;
}

export function isIntegerMember(
  container: object,
  key: string | number,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  const value = (container as Record<string | number, unknown>)[key];
  const lexeme = numberLexemes.get(container)?.get(key);
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum &&
    (lexeme === undefined || /^-?(?:0|[1-9][0-9]*)$/.test(lexeme))
  );
}

class ParsedNumber {
  constructor(
    readonly value: number,
    readonly lexeme: string,
  ) {}
}

class JSONParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const parsed = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("Unexpected content after the JSON value");
    }
    return parsed instanceof ParsedNumber ? parsed.value : parsed;
  }

  private parseValue(): unknown {
    const character = this.text[this.index];
    switch (character) {
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.fail("JSON null is outside the portable protocol profile");
      default:
        if (character === "-" || isDigit(character)) {
          return this.parseNumber();
        }
        return this.fail("Expected a JSON value");
    }
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = {};
    const members = new Set<string>();
    if (this.consume("}")) {
      return result;
    }

    while (true) {
      if (this.text[this.index] !== '"') {
        this.fail("Expected an object member name");
      }
      const key = this.parseString();
      if (members.has(key)) {
        this.fail("Duplicate object member");
      }
      members.add(key);
      this.skipWhitespace();
      this.require(":", "Expected ':' after an object member name");
      this.skipWhitespace();
      const parsed = this.parseValue();
      const value = unwrapNumber(result, key, parsed);
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      this.skipWhitespace();
      if (this.consume("}")) {
        return result;
      }
      this.require(",", "Expected ',' between object members");
      this.skipWhitespace();
    }
  }

  private parseArray(): unknown[] {
    this.index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.consume("]")) {
      return result;
    }

    while (true) {
      const parsed = this.parseValue();
      const index = result.length;
      result.push(unwrapNumber(result, index, parsed));
      this.skipWhitespace();
      if (this.consume("]")) {
        return result;
      }
      this.require(",", "Expected ',' between array values");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let result = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index] as string;
      this.index += 1;
      if (character === '"') {
        return result;
      }
      if (character === "\\") {
        const escape = this.text[this.index] as string | undefined;
        this.index += 1;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            result += escape;
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const first = this.parseHexCodeUnit();
            if (isHighSurrogate(first)) {
              if (!this.text.startsWith("\\u", this.index)) {
                this.fail("Unpaired high surrogate in JSON string");
              }
              this.index += 2;
              const second = this.parseHexCodeUnit();
              if (!isLowSurrogate(second)) {
                this.fail("Unpaired high surrogate in JSON string");
              }
              result += String.fromCharCode(first, second);
            } else if (isLowSurrogate(first)) {
              this.fail("Unpaired low surrogate in JSON string");
            } else {
              result += String.fromCharCode(first);
            }
            break;
          }
          default:
            this.fail("Invalid JSON string escape");
        }
      } else {
        if (character.charCodeAt(0) <= 0x1f) {
          this.fail("Unescaped control character in JSON string");
        }
        const codeUnit = character.charCodeAt(0);
        if (isHighSurrogate(codeUnit)) {
          const second = this.text.charCodeAt(this.index);
          if (!isLowSurrogate(second)) {
            this.fail("Unpaired high surrogate in JSON string");
          }
          result += character + this.text[this.index];
          this.index += 1;
        } else if (isLowSurrogate(codeUnit)) {
          this.fail("Unpaired low surrogate in JSON string");
        } else {
          result += character;
        }
      }
    }
    return this.fail("Unterminated JSON string");
  }

  private parseHexCodeUnit(): number {
    const hex = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      this.fail("Invalid Unicode escape in JSON string");
    }
    this.index += 4;
    return Number.parseInt(hex, 16);
  }

  private parseNumber(): ParsedNumber {
    const start = this.index;
    this.consume("-");
    if (this.consume("0")) {
      if (isDigit(this.text[this.index])) {
        this.fail("Leading zero in JSON number");
      }
    } else {
      this.requireDigits("Expected digits in JSON number");
    }
    if (this.consume(".")) {
      this.requireDigits("Expected digits after decimal point");
    }
    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.index += 1;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") {
        this.index += 1;
      }
      this.requireDigits("Expected digits in JSON exponent");
    }
    const lexeme = this.text.slice(start, this.index);
    if (!/^(?:0|[1-9][0-9]*)$/.test(lexeme)) {
      this.fail(
        "JSON number is outside the portable non-negative integer profile",
      );
    }
    const value = Number(lexeme);
    if (!Number.isSafeInteger(value)) {
      this.fail("JSON number exceeds the portable safe-integer range");
    }
    return new ParsedNumber(value, lexeme);
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.index)) {
      this.fail(`Expected '${literal}'`);
    }
    this.index += literal.length;
    return value;
  }

  private requireDigits(message: string): void {
    if (!isDigit(this.text[this.index])) {
      this.fail(message);
    }
    while (isDigit(this.text[this.index])) {
      this.index += 1;
    }
  }

  private skipWhitespace(): void {
    while (
      this.text[this.index] === " " ||
      this.text[this.index] === "\t" ||
      this.text[this.index] === "\n" ||
      this.text[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private consume(character: string): boolean {
    if (this.text[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private require(character: string, message: string): void {
    if (!this.consume(character)) {
      this.fail(message);
    }
  }

  private fail(message: string): never {
    throw new StrictJSONError(`${message} at byte ${Buffer.byteLength(this.text.slice(0, this.index), "utf8")}`);
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function unwrapNumber(
  container: object,
  key: string | number,
  value: unknown,
): unknown {
  if (!(value instanceof ParsedNumber)) {
    return value;
  }
  let lexemes = numberLexemes.get(container);
  if (lexemes === undefined) {
    lexemes = new Map();
    numberLexemes.set(container, lexemes);
  }
  lexemes.set(key, value.lexeme);
  return value.value;
}
