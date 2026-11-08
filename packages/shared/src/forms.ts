import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type FormSchema = boolean | {
  type?: string | string[];
  title?: string;
  description?: string;
  format?: string;
  writeOnly?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  enumNames?: string[];
  const?: JsonValue;
  properties?: Record<string, FormSchema>;
  required?: string[];
  items?: FormSchema | { id: string; title: string; image: string }[];
  additionalProperties?: FormSchema;
  oneOf?: FormSchema[];
  anyOf?: FormSchema[];
  [key: string]: unknown;
};

type SchemaObject = Exclude<FormSchema, boolean>;
export interface FormUploadConfig { accept: string[]; kind: 'file' | 'directory' }
export interface FormImageChoice { id: string; title: string; image: string }
export interface FormFileChoice { uri: string; name: string; icons?: { src: string }[] }
export function formImageChoices(schema: FormSchema): FormImageChoice[] | null {
  if (typeof schema !== 'object' || schema.type !== 'openai/imagePicker') return null;
  if (!Array.isArray(schema.items) || schema.items.some((item) => !item || typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string' || typeof item.image !== 'string') || new Set(schema.items.map((item) => item.id)).size !== schema.items.length) throw new Error('画像選択フォームの定義が不正です。');
  return schema.items;
}
export function formFileChoices(schema: FormSchema): FormFileChoice[] | null {
  if (typeof schema !== 'object') return null;
  const input = schema['x-openai-input'] as { type?: unknown; options?: unknown } | undefined;
  if (!input || input.type !== 'file') return null;
  if (!Array.isArray(input.options) || input.options.some((option) => !option || typeof option.uri !== 'string' || typeof option.name !== 'string')) throw new Error('ファイル選択フォームの定義が不正です。');
  return input.options.map((option) => ({ uri: option.uri, name: typeof option.title === 'string' ? option.title : option.name, ...(Array.isArray(option.icons) ? { icons: option.icons.filter((icon: { src?: unknown }) => typeof icon?.src === 'string') } : {}) }));
}
function uploadConfig(schema: SchemaObject): FormUploadConfig | null {
  const input = schema['x-openai-input'] as { type?: string; userOptions?: { kind?: string; accept?: string[] } } | undefined;
  const value = schema.type === 'openai/imagePicker' ? schema.file as { accept?: string[] } | undefined : input?.type === 'file' ? input.userOptions : undefined;
  if (!value || typeof value !== 'object') return null;
  if ('kind' in value && value.kind !== undefined && value.kind !== 'file' && value.kind !== 'directory') throw new Error('ファイル選択の種類に対応していません。');
  const kind = 'kind' in value && value.kind === 'directory' ? 'directory' : 'file';
  return { kind, accept: Array.isArray(value.accept) ? value.accept.filter((s): s is string => typeof s === 'string') : [] };
}
function dereference(schema: FormSchema, root: FormSchema, depth = 0): SchemaObject | null {
  if (typeof schema !== 'object' || depth > 24) return null;
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/')) return null;
    let target: unknown = root;
    for (const segment of schema.$ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, segment)) return null;
      target = (target as Record<string, unknown>)[segment];
    }
    const resolved = dereference(target as FormSchema, root, depth + 1);
    const { $ref: _, ...rest } = schema;
    return resolved ? { ...resolved, ...rest } : null;
  }
  return schema;
}
export function formUploadConfig(root: FormSchema, fieldPath: readonly string[]): FormUploadConfig | null {
  if (fieldPath.length > 24) return null;
  const resolve = (schema: FormSchema, path: readonly string[], depth: number): FormUploadConfig | null => {
    if (depth > 32) return null;
    const current = dereference(schema, root);
    if (!current) return null;
    const candidates: FormUploadConfig[] = [];
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) if (Array.isArray(current[key])) {
      for (const branch of current[key] as FormSchema[]) {
        const config = resolve(branch, path, depth + 1);
        if (config) candidates.push(config);
      }
    }
    const segment = path[0];
    if (segment === undefined) {
      const config = uploadConfig(current);
      if (config) candidates.push(config);
    } else {
    const child = current.type === 'array' && /^(0|[1-9]\d*)$/.test(segment)
      ? (Array.isArray(current.prefixItems) ? current.prefixItems[Number(segment)] as FormSchema : undefined) ?? (Array.isArray(current.items) ? undefined : current.items)
      : current.properties && Object.hasOwn(current.properties, segment) ? current.properties[segment] : current.additionalProperties;
      if (child !== undefined) { const config = resolve(child, path.slice(1), depth + 1); if (config) candidates.push(config); }
    }
    // Ambiguous upload policies must not silently broaden server-side permission.
    return candidates.length && candidates.every((config) => config.kind === candidates[0].kind && JSON.stringify([...config.accept].sort()) === JSON.stringify([...candidates[0].accept].sort())) ? candidates[0] : null;
  };
  return resolve(root, fieldPath, 0);
}

/** Preserve JSON Schema constraints while expressing rich picker choices as ordinary value constraints. */
function validationSchema(schema: FormSchema, depth = 0): FormSchema {
  if (typeof schema === 'boolean') return schema;
  if (!schema || depth > 32) throw new Error();
  const result: SchemaObject = { ...schema };
  for (const key of ['properties', '$defs', 'definitions', 'patternProperties'] as const) {
    const entries = schema[key];
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) result[key] = Object.fromEntries(Object.entries(entries).map(([name, child]) => [name, validationSchema(child as FormSchema, depth + 1)]));
  }
  for (const key of ['additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else'] as const) if (schema[key] !== undefined) result[key] = validationSchema(schema[key] as FormSchema, depth + 1);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) if (Array.isArray(schema[key])) result[key] = (schema[key] as FormSchema[]).map((child) => validationSchema(child, depth + 1));
  const imageChoices = formImageChoices(schema);
  if (imageChoices) {
    if (!imageChoices.length && !uploadConfig(schema)) throw new Error();
    delete result.items; delete result.file;
    result.type = 'string';
    result.allOf = [...(Array.isArray(result.allOf) ? result.allOf : []), { anyOf: [imageChoices.length ? { enum: imageChoices.map((item) => item.id) } : false,
      ...(uploadConfig(schema) ? [{ type: 'string', format: 'uri', pattern: '^file:///' } as FormSchema] : [])] }];
  } else if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) throw new Error();
    result.items = validationSchema(schema.items, depth + 1);
  }
  const fileChoices = formFileChoices(schema);
  if (fileChoices) {
    const allowed: FormSchema = { anyOf: [fileChoices.length ? { enum: fileChoices.map((choice) => choice.uri) } : false,
      ...(uploadConfig(schema) ? [{ type: 'string', format: 'uri', pattern: '^file:///' } as FormSchema] : [])] };
    const constraint: FormSchema = schema.type === 'array' ? { type: 'array', items: allowed } : { type: 'string', ...allowed as object };
    result.allOf = [...(Array.isArray(result.allOf) ? result.allOf : []), constraint];
  }
  return result;
}

/** 入力値やschema内の秘密値をエラーに含めない。外部$ref取得・型変換・既定値補完を行わない。 */
export function prepareFormValidator(schema: FormSchema): (content: unknown) => string | null {
  try {
    const encoded = JSON.stringify(schema);
    if (!encoded || encoded.length > 4_000_000) throw new Error();
    const modern = typeof schema === 'object' && typeof schema.$schema === 'string' && /2020-12/.test(schema.$schema);
    const options = { strict: false, strictNumbers: true, ownProperties: true, allErrors: false, logger: false as const };
    const validator = modern ? new Ajv2020(options) : new Ajv(options);
    addFormats(validator);
    validator.addFormat('password', true);
    const validate = validator.compile(validationSchema(schema));
    if ('$async' in validate && validate.$async) throw new Error();
    return (content) => {
      try {
        const serialized = JSON.stringify(content);
        if (serialized === undefined) return '入力内容を指定してください。';
        if (serialized.length > 128_000) return '入力内容が長すぎます。';
        if (validate(content)) return null;
        // keywordのみ使う。schemaのenum値や送信内容をエラーへ転記しない。
        const error = validate.errors?.[0];
        const field = `${error?.instancePath || '回答'}${error?.keyword === 'required' ? `/${String(error.params.missingProperty)}` : ''}`;
        return `${field}: 入力内容を確認してください（${error?.keyword ?? 'schema'}）。必須項目・型・文字数・値の範囲が指定に合っていません。`;
      } catch { return '入力内容を検証できませんでした。'; }
    };
  } catch {
    throw new Error('この入力フォームの定義を読み取れません。未対応の参照や不正な形式が含まれています。辞退または取消ができます。');
  }
}

export function validateFormContent(schema: FormSchema, content: unknown): string | null {
  return prepareFormValidator(schema)(content);
}
