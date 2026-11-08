import React, { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ATTACH_LIMITS, formFileChoices, formImageChoices, formUploadConfig, prepareFormValidator, workDir, type FormSchema, type JsonValue, type PendingForm, type Session } from '@tower/shared';
import { api, errMsg } from '../api';
import { btn } from '../lib';

type Schema = Exclude<FormSchema, boolean>;
const inputClass = 'w-full rounded border border-zinc-600 bg-zinc-950 px-2 py-1.5 text-sm';
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const objectValue = (value: JsonValue | undefined): Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const FormContext = createContext<{ session: Session; pending: PendingForm; setUploading: React.Dispatch<React.SetStateAction<number>> } | null>(null);

export function safeFormPreview(source: unknown): { src: string; remote: boolean } | null {
  if (typeof source !== 'string' || source.length > 2_000_000) return null;
  if (/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source)) return { src: source, remote: false };
  try { const url = new URL(source); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return { src: url.href, remote: true }; } catch { /* unsupported URL */ }
  return null;
}

function FormPreview({ source, title }: { source?: unknown; title: string }) {
  const preview = safeFormPreview(source);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setLoaded(false); setFailed(false); }, [source]);
  if (!source) return null;
  if (!preview || failed) return <span className="block text-xs text-zinc-500">画像を表示できません</span>;
  if (preview.remote && !loaded) return <button type="button" className="text-xs text-sky-300 underline" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setLoaded(true); }}>画像を読み込む（{new URL(preview.src).host}）</button>;
  // SVG is confined to an img context, never inline HTML, object, iframe or navigation.
  return <img src={preview.src} alt={title} referrerPolicy="no-referrer" className="max-h-40 max-w-full object-contain rounded" onError={() => setFailed(true)} />;
}

function Picker({ schema, root, fieldPath, value, onChange, name, secret }: { schema: Schema; root: FormSchema; fieldPath: string[]; value: JsonValue | undefined; onChange: (value: JsonValue | undefined) => void; name: string; secret: boolean }) {
  const context = useContext(FormContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [directoryInput, setDirectoryInput] = useState(context ? workDir(context.session) : '');
  const [directory, setDirectory] = useState<Awaited<ReturnType<typeof api.browseProjects>> | null>(null);
  const images = formImageChoices(schema);
  const files = formFileChoices(schema);
  const options = images?.map((image) => ({ value: image.id, title: image.title, image: image.image })) ?? files?.map((file) => ({ value: file.uri, title: file.name, image: file.icons?.[0]?.src })) ?? [];
  const multi = !images && schema.type === 'array';
  const selected = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : [];
  const hiddenValue = (candidate: string) => {
    const answer: JsonValue = multi ? [candidate] : candidate;
    return secret || JSON.stringify(reviewFormValue(answer, schema, root, name)) !== JSON.stringify(answer);
  };
  const upload = formUploadConfig(root, fieldPath);
  const choose = (next: string) => onChange(multi ? selected.includes(next) ? selected.filter((v) => v !== next) : [...selected, next] : next);
  const attach = async (file?: File, directoryPath?: string) => {
    if (!context || busy) return;
    setBusy(true); setError(''); context.setUploading((count) => count + 1);
    try {
      if (file && file.size > ATTACH_LIMITS.fileBytes) throw new Error('添付ファイルが大きすぎます。');
      const base = { requestId: context.pending.id, fieldPath };
      let result: { uri: string; name: string };
      if (directoryPath) result = await api.uploadFormAttachment(context.session.id, { ...base, directoryPath });
      else {
        if (!file) return;
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',', 2)[1]); reader.onerror = () => reject(new Error('ファイルを読み込めませんでした。')); reader.readAsDataURL(file); });
        result = await api.uploadFormAttachment(context.session.id, { ...base, attachment: { name: file.name, mime: file.type, data } });
      }
      onChange(multi ? [...new Set([...selected, result.uri])] : result.uri);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); context.setUploading((count) => count - 1); }
  };
  const browse = async (next: string) => {
    setBusy(true); setError('');
    try { const result = await api.browseProjects(next); setDirectory(result); setDirectoryInput(result.path); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return <fieldset disabled={busy} aria-label={name} className="space-y-2">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{options.map((option, index) => <label key={`${option.value}-${index}`} className="border border-zinc-600 rounded p-2 space-y-1 cursor-pointer">
      <span className="flex items-center gap-2"><input type={multi ? 'checkbox' : 'radio'} checked={selected.includes(option.value)} onChange={() => choose(option.value)} />{hiddenValue(option.value) ? `選択肢 ${index + 1}（機密値）` : option.title}</span>
      {!hiddenValue(option.value) && <FormPreview source={option.image} title={option.title} />}
    </label>)}</div>
    {selected.filter((item) => !options.some((option) => option.value === item)).map((item) => <p key={item} className="text-xs break-all">選択済み: {hiddenValue(item) ? '••••••（非表示）' : item}<button type="button" className="ml-2 underline" onClick={() => onChange(multi ? selected.filter((v) => v !== item) : undefined)}>解除</button></p>)}
    {upload?.kind === 'file' && <label className="block text-xs">ファイルを選択<input type="file" accept={upload.accept.join(',')} className="block mt-1 max-w-full" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void attach(file); }} /></label>}
    {upload?.kind === 'directory' && <div className="space-y-1">
      <label className="block text-xs">フォルダーの場所<input className={inputClass} value={directoryInput} onChange={(e) => setDirectoryInput(e.target.value)} /></label>
      <button type="button" className={`${btn.base} ${btn.ghost}`} onClick={() => void browse(directoryInput)}>フォルダーを確認</button>
      {directory && <div className="border border-zinc-700 rounded p-2 space-y-1"><p className="text-xs break-all">{directory.path}</p>
        {directory.parent && <button type="button" className="block text-sky-300" onClick={() => void browse(directory.parent!)}>上のフォルダーへ</button>}
        {directory.projects.map((folder) => <button key={folder.path} type="button" className="block text-sky-300" onClick={() => void browse(folder.path)}>{folder.name}</button>)}
        <button type="button" className={`${btn.base} ${btn.ghost}`} onClick={() => void attach(undefined, directory.path)}>このフォルダーを選択</button>
      </div>}
    </div>}
    {busy && <p role="status" className="text-xs">ファイルの選択を確認しています…</p>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </fieldset>;
}

/** UIもローカル参照を辿る。参照先をネットから取得しない。 */
function resolveSchema(schema: FormSchema, root: FormSchema, depth = 0): Schema {
  if (depth > 24) throw new Error('フォームの入れ子が深すぎます。');
  if (schema === false) throw new Error('この項目は入力を受け付けない定義です。');
  if (schema === true) return {};
  if (schema.$ref) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) throw new Error('このフォームの参照形式には対応していません。');
    let target: unknown = root;
    for (const part of schema.$ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!target || typeof target !== 'object' || !own(target, part)) throw new Error('フォームの参照先が見つかりません。');
      target = (target as Record<string, unknown>)[part];
    }
    const { $ref: _, ...rest } = schema;
    return { ...resolveSchema(target as FormSchema, root, depth + 1), ...rest };
  }
  if (Array.isArray(schema.allOf)) {
    const { allOf: _, ...rest } = schema;
    return (schema.allOf as FormSchema[]).reduce<Schema>((merged, part) => {
      const next = resolveSchema(part, root, depth + 1);
      return { ...merged, ...next, properties: { ...merged.properties, ...next.properties }, required: [...new Set([...(merged.required ?? []), ...(next.required ?? [])])] };
    }, rest);
  }
  return schema;
}

function choicesFor(schema: Schema): { value: JsonValue; label: string; preview?: unknown }[] | null {
  if (schema.enum) return schema.enum.map((value, index) => ({ value, label: schema.enumNames?.[index] ?? String(value) }));
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants?.length && variants.every((part) => typeof part === 'object' && own(part, 'const'))) {
    return variants.map((part) => ({ value: (part as Schema).const!, label: (part as Schema).title ?? String((part as Schema).const), preview: ((part as Schema)['x-openai-preview'] as { src?: unknown } | undefined)?.src }));
  }
  return null;
}

function NumberInput({ value, onChange, integer, id }: { value: JsonValue | undefined; onChange: (value: JsonValue | undefined) => void; integer: boolean; id: string }) {
  const [raw, setRaw] = useState(typeof value === 'number' ? String(value) : '');
  useEffect(() => { if (typeof value === 'number' && Number(raw) !== value) setRaw(String(value)); }, [value, raw]);
  return <input id={id} type="number" step={integer ? '1' : 'any'} className={inputClass} value={raw} onChange={(e) => {
    const text = e.target.value;
    setRaw(text);
    const number = Number(text);
    onChange(text !== '' && Number.isFinite(number) ? number : undefined);
  }} />;
}

function Field({ definition, root, value, onChange, name, depth = 0, fieldPath = [] }: { definition: FormSchema; root: FormSchema; value: JsonValue | undefined; onChange: (value: JsonValue | undefined) => void; name: string; depth?: number; fieldPath?: string[] }) {
  const id = useId();
  const [variant, setVariant] = useState('');
  const [newKey, setNewKey] = useState('');
  const rowIds = useRef<number[]>([]);
  const nextRowId = useRef(0);
  let schema: Schema;
  try { schema = resolveSchema(definition, root); if (depth > 20) throw new Error('フォームの入れ子が深すぎます。'); }
  catch (e) { return <p role="alert" className="text-red-300 text-xs">{errMsg(e)}</p>; }
  const choices = choicesFor(schema);
  const richPicker = schema.type === 'openai/imagePicker' || (schema['x-openai-input'] as { type?: string } | undefined)?.type === 'file';
  const variants = choices ? undefined : schema.oneOf ?? schema.anyOf;
  const declaredType = schema.type;
  const type = typeof declaredType === 'string' ? declaredType : schema.properties ? 'object' : schema.items ? 'array' : undefined;
  const secret = schema.writeOnly || schema.format === 'password' || /password|secret|token|api.?key/i.test(name);
  const selected = choices?.findIndex((choice) => JSON.stringify(choice.value) === JSON.stringify(value)) ?? -1;
  const properties = schema.properties ?? {};
  const object = objectValue(value);
  const extraKeys = Object.keys(object).filter((key) => !own(properties, key));
  while (rowIds.current.length < (Array.isArray(value) ? value.length : 0)) rowIds.current.push(nextRowId.current++);
  const setProperty = (key: string, next: JsonValue | undefined) => onChange(Object.fromEntries([
    ...Object.entries(object).filter(([k]) => k !== key), ...(next === undefined ? [] : [[key, next] as const]),
  ]));
  return <div className="space-y-1.5 min-w-0">
    <label htmlFor={id} className="block text-sm font-medium">{schema.title ?? name}{schema.title && name.endsWith('（必須）') ? '（必須）' : ''}</label>
    {schema.description && <p className="text-xs text-zinc-400 whitespace-pre-wrap">{schema.description}</p>}
    {own(schema, 'default') && <button type="button" className="text-xs text-sky-300 underline" onClick={() => onChange(schema.default)}>指定された既定値を使う（{JSON.stringify(reviewFormValue(schema.default, definition, root, name))}）</button>}
    {own(schema, 'const') ? <button id={id} type="button" className={`${btn.base} ${btn.ghost}`} onClick={() => onChange(schema.const)}>指定値を使う: {JSON.stringify(reviewFormValue(schema.const, definition, root, name))}</button>
      : richPicker ? <Picker schema={schema} root={root} fieldPath={fieldPath} value={value} onChange={onChange} name={name} secret={!!secret} />
      : choices?.some((choice) => choice.preview) ? <div id={id} className="grid grid-cols-1 sm:grid-cols-2 gap-2">{choices.map((choice, index) => {
        const hidden = JSON.stringify(reviewFormValue(choice.value, definition, root, name)) !== JSON.stringify(choice.value);
        return <label key={index} className="border border-zinc-600 rounded p-2 space-y-1 cursor-pointer"><span className="flex gap-2 items-center"><input type="radio" checked={selected === index} onChange={() => onChange(choice.value)} />{hidden ? `選択肢 ${index + 1}（機密値）` : choice.label}</span>{!hidden && <FormPreview source={choice.preview} title={choice.label} />}</label>;
      })}</div>
      : choices ? <select id={id} className={inputClass} value={selected < 0 ? '' : String(selected)} onChange={(e) => onChange(e.target.value === '' ? undefined : choices[Number(e.target.value)].value)}>
        <option value="">選択してください</option>{choices.map((choice, index) => <option key={index} value={index}>{JSON.stringify(reviewFormValue(choice.value, definition, root, name)) !== JSON.stringify(choice.value) ? `選択肢 ${index + 1}（機密値）` : choice.label}</option>)}
      </select>
      : variants || Array.isArray(declaredType) || !type ? <>
        <select id={id} className={inputClass} value={variant} onChange={(e) => { setVariant(e.target.value); onChange(undefined); }}>
          <option value="">入力の種類を選択</option>
          {(variants ?? (Array.isArray(declaredType) ? declaredType : ['string', 'number', 'boolean', 'object', 'array', 'null']).map((t): FormSchema => ({ type: t }))).map((part, index) => <option key={index} value={index}>{typeof part === 'object' ? part.title ?? String(part.type ?? `選択肢 ${index + 1}`) : `選択肢 ${index + 1}`}</option>)}
        </select>
        {variant !== '' && <Field key={variant} definition={variants?.[Number(variant)] ?? { ...schema, type: (Array.isArray(declaredType) ? declaredType : ['string', 'number', 'boolean', 'object', 'array', 'null'])[Number(variant)] }} root={root} value={value} onChange={onChange} name={name} depth={depth + 1} fieldPath={fieldPath} />}
      </>
      : type === 'object' ? <div id={id} className="space-y-3 border-l border-zinc-700 pl-3">
        {Object.entries(properties).map(([key, child]) => {
          const required = schema.required?.includes(key);
          const included = own(object, key);
          return <div key={key} className="space-y-1">
            {!required && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={included} onChange={(e) => setProperty(key, e.target.checked ? null : undefined)} />{typeof child === 'object' ? child.title ?? key : key} を含める（任意）</label>}
            {(required || included) && <Field definition={child} root={root} value={object[key]} onChange={(next) => setProperty(key, next)} name={`${key}${required ? '（必須）' : ''}`} depth={depth + 1} fieldPath={[...fieldPath, key]} />}
          </div>;
        })}
        {extraKeys.map((key) => <div key={key}><Field definition={schema.additionalProperties ?? true} root={root} value={object[key]} onChange={(next) => setProperty(key, next)} name={key} depth={depth + 1} fieldPath={[...fieldPath, key]} /><button type="button" className="text-xs text-red-300" onClick={() => setProperty(key, undefined)}>{key} を削除</button></div>)}
        {schema.additionalProperties !== false && <div className="flex gap-2"><input className={inputClass} aria-label={`${name}の追加項目名`} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="追加する項目名" /><button type="button" disabled={!newKey || own(object, newKey) || own(properties, newKey)} className={`${btn.base} ${btn.ghost}`} onClick={() => { setProperty(newKey, null); setNewKey(''); }}>項目を追加</button></div>}
        {value === undefined && <button type="button" className="text-xs text-sky-300" onClick={() => onChange({})}>空のオブジェクトを使う</button>}
      </div>
      : type === 'array' ? <div id={id} className="space-y-2 border-l border-zinc-700 pl-3">
        {(Array.isArray(value) ? value : []).map((item, index) => <div key={rowIds.current[index]} className="space-y-1">
          <Field definition={(Array.isArray(schema.prefixItems) ? schema.prefixItems[index] as FormSchema : undefined) ?? (Array.isArray(schema.items) ? true : schema.items ?? true)} root={root} value={item} onChange={(next) => onChange((value as JsonValue[]).map((v, i) => i === index ? next ?? null : v))} name={`${name} ${index + 1}`} depth={depth + 1} fieldPath={[...fieldPath, String(index)]} />
          <button type="button" className="text-xs text-red-300" onClick={() => { rowIds.current.splice(index, 1); onChange((value as JsonValue[]).filter((_, i) => i !== index)); }}>項目 {index + 1} を削除</button>
        </div>)}
        <button type="button" className={`${btn.base} ${btn.ghost}`} onClick={() => { rowIds.current = rowIds.current.slice(0, Array.isArray(value) ? value.length : 0); rowIds.current.push(nextRowId.current++); onChange([...(Array.isArray(value) ? value : []), null]); }}>項目を追加</button>
        {!Array.isArray(value) && <button type="button" className="ml-2 text-xs text-sky-300" onClick={() => onChange([])}>空の一覧を使う</button>}
      </div>
      : type === 'boolean' ? <select id={id} className={inputClass} value={typeof value === 'boolean' ? String(value) : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">選択してください</option><option value="true">はい</option><option value="false">いいえ</option></select>
      : type === 'number' || type === 'integer' ? <NumberInput id={id} value={value} onChange={onChange} integer={type === 'integer'} />
      : type === 'null' ? <button id={id} type="button" className={`${btn.base} ${btn.ghost}`} onClick={() => onChange(null)}>値なし（null）を使う{value === null ? ' ✓' : ''}</button>
      : type === 'string' ? <input id={id} autoComplete="off" type={secret ? 'password' : 'text'} className={inputClass} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
      : <p role="alert" className="text-red-300 text-xs">未対応の入力形式です。辞退または取消ができます。</p>}
  </div>;
}

/** 確認表示でもsecret/writeOnly/passwordと機密項目名を隠す。送信値自体は加工しない。 */
export function reviewFormValue(value: JsonValue | undefined, definition: FormSchema, root: FormSchema, name = ''): JsonValue {
  let schema: Schema;
  try { schema = resolveSchema(definition, root); } catch { return '表示できません'; }
  if (schema.writeOnly || schema.format === 'password' || /password|secret|token|api.?key/i.test(name)) return '••••••（非表示）';
  const variants = (schema.oneOf ?? schema.anyOf ?? []).map((part) => { try { return resolveSchema(part, root); } catch { return {} as Schema; } });
  if (variants.some((part) => part.writeOnly || part.format === 'password')) return '••••••（非表示）';
  if (Array.isArray(value)) return value.map((item, index) => {
    const parts = [schema, ...variants].map(part => (Array.isArray(part.prefixItems) ? part.prefixItems[index] as FormSchema : undefined) ?? (Array.isArray(part.items) ? undefined : part.items)).filter((part): part is FormSchema => part !== undefined);
    return reviewFormValue(item, parts.length > 1 ? { anyOf: parts } : parts[0] ?? true, root);
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const parts = [schema, ...variants].map((part) => part.properties?.[key] ?? part.additionalProperties).filter((part): part is FormSchema => part !== undefined);
    return [key, reviewFormValue(item, parts.length > 1 ? { anyOf: parts } : parts[0] ?? true, root, key)];
  }));
  return value ?? null;
}

export function FormCard({ session, pending }: { session: Session; pending: PendingForm }) {
  const [uploading, setUploading] = useState(0);
  const [value, setValue] = useState<JsonValue | undefined>();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validation = useMemo(() => {
    try { return { validate: prepareFormValidator(pending.schema), error: '' }; }
    catch (e) { return { validate: null, error: errMsg(e) }; }
  }, [pending.schema]);
  const submit = async (action: 'accept' | 'decline' | 'cancel') => {
    if (busy || uploading) return;
    if (action === 'accept') {
      const invalid = validation.error || validation.validate?.(value);
      if (invalid) { setError(invalid); return; }
    }
    setBusy(true); setError('');
    try { await api.answerForm(session.id, { requestId: pending.id, action, ...(action === 'accept' ? { content: value } : {}) }); setValue(undefined); }
    catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return <FormContext.Provider value={{ session, pending, setUploading }}><section aria-label="入力フォーム" className="rounded-lg border border-violet-400/40 bg-violet-400/5 p-3 space-y-3">
    <div className="font-medium">{pending.serverName} からの入力依頼</div>
    <p className="text-sm whitespace-pre-wrap">{pending.message}</p>
    <p className="text-xs text-zinc-400">送信先: {pending.serverName}。入力内容はTowerの経過に記録しません。</p>
    {validation.error ? <p role="alert" className="text-red-300 text-sm">{validation.error}</p> : <fieldset disabled={busy || !!uploading} className="min-w-0">
      {reviewing ? <><p className="text-sm mb-2">この内容を送信します。</p><pre className="text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto">{JSON.stringify(reviewFormValue(value, pending.schema, pending.schema), null, 2)}</pre><button type="button" className={`${btn.base} ${btn.ghost} mt-2`} onClick={() => setReviewing(false)}>入力に戻る</button></> : <Field definition={pending.schema} root={pending.schema} value={value} onChange={setValue} name="回答" />}
    </fieldset>}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy || !!uploading || !!validation.error} className={`${btn.base} ${btn.primary}`} onClick={() => {
        if (reviewing) void submit('accept');
        else { const invalid = validation.validate?.(value); setError(invalid ?? ''); if (!invalid) setReviewing(true); }
      }}>{reviewing ? '確認して送信' : '入力内容を確認'}</button>
      <button type="button" disabled={busy || !!uploading} className={`${btn.base} ${btn.danger}`} onClick={() => void submit('decline')}>辞退</button>
      <button type="button" disabled={busy || !!uploading} className={`${btn.base} ${btn.ghost}`} onClick={() => void submit('cancel')}>取消</button>
    </div>
    {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
  </section></FormContext.Provider>;
}
