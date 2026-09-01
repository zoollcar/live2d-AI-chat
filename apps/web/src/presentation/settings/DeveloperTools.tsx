import { useEffect, useMemo, useState } from "react";
import type { AgentToolCategory } from "@/agent/tools";

export interface ManualToolDefinition {
  name: string;
  description: string;
  category: AgentToolCategory;
  inputSchema: Record<string, unknown>;
}

interface Props {
  disabled?: boolean;
  tools: ManualToolDefinition[];
  onInvoke(name: string, input: unknown): Promise<unknown>;
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  default?: unknown;
};

const categoryLabels: Record<AgentToolCategory, string> = {
  scene: "Character & stage",
  workspace: "Stage content",
  read: "Read & inspect",
};

function initialValue(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "object") {
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([key]) => schema.required?.includes(key))
      .map(([key, child]) => [key, initialValue(child)]));
  }
  return "";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function DeveloperTools({ disabled, tools, onInvoke }: Props) {
  const [selectedName, setSelectedName] = useState(tools[0]?.name ?? "");
  const selected = tools.find((tool) => tool.name === selectedName) ?? tools[0];
  const schema = selected?.inputSchema as JsonSchema | undefined;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonInput, setJsonInput] = useState("{}");
  const [result, setResult] = useState<{ kind: "success" | "error"; text: string }>();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const next = initialValue(schema ?? { type: "object" }) as Record<string, unknown>;
    setValues(next);
    setJsonInput(stringify(next));
    setResult(undefined);
  }, [selectedName, schema]);

  const groupedTools = useMemo(() => Object.entries(categoryLabels).map(([category, label]) => ({
    category: category as AgentToolCategory,
    label,
    tools: tools.filter((tool) => tool.category === category),
  })).filter((group) => group.tools.length > 0), [tools]);

  const properties = Object.entries(schema?.properties ?? {});
  const invoke = async () => {
    if (!selected) return;
    setRunning(true);
    setResult(undefined);
    try {
      const input = jsonMode ? JSON.parse(jsonInput) : values;
      const output = await onInvoke(selected.name, input);
      setResult({ kind: "success", text: stringify(output) });
    } catch (error) {
      setResult({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <details className="settings-section route-settings-details developer-tools">
      <summary><strong>Developer tools</strong><small>Manually invoke registered tools</small></summary>
      <p className="settings-section-copy">Runs the same validated tools available to the active model. Calls can immediately change the character or stage.</p>
      <label className="field"><span>Tool</span><select className="developer-tool-select" value={selected?.name ?? ""} onChange={(event) => setSelectedName(event.target.value)}>
        {groupedTools.map((group) => <optgroup key={group.category} label={group.label}>
          {group.tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
        </optgroup>)}
      </select></label>
      {selected ? <p className="developer-tool-description">{selected.description}</p> : null}
      <div className="developer-tool-mode" role="group" aria-label="Parameter editor mode">
        <button type="button" className={!jsonMode ? "active" : ""} onClick={() => setJsonMode(false)}>Form</button>
        <button type="button" className={jsonMode ? "active" : ""} onClick={() => { setJsonInput(stringify(values)); setJsonMode(true); }}>JSON</button>
      </div>
      {jsonMode ? (
        <label className="field"><span>Arguments</span><textarea className="developer-tool-json" spellCheck={false} value={jsonInput} onChange={(event) => setJsonInput(event.target.value)} /></label>
      ) : (
        <div className="developer-tool-fields">
          {properties.length === 0 ? <span className="status-copy">This tool does not require arguments.</span> : properties.map(([name, property]) => {
            const required = schema?.required?.includes(name);
            const value = values[name];
            const update = (next: unknown) => setValues((current) => {
              if (!required && (next === "" || next === undefined)) {
                const copy = { ...current };
                delete copy[name];
                return copy;
              }
              return { ...current, [name]: next };
            });
            if (property.type === "array" && property.items?.enum) return (
              <fieldset className="developer-tool-options" key={name}><legend>{name}{required ? " *" : ""}</legend>
                {property.items.enum.map((option) => <label key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={(event) => {
                  const current = Array.isArray(value) ? value as string[] : [];
                  update(event.target.checked ? [...current, option] : current.filter((item) => item !== option));
                }} />{option}</label>)}
              </fieldset>
            );
            if (property.enum) return <label className="field" key={name}><span>{name}{required ? " *" : ""}</span><select value={String(value ?? "")} onChange={(event) => update(event.target.value)}>{!required ? <option value="">Not set</option> : null}{property.enum.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
            if (property.type === "object") return <label className="field" key={name}><span>{name}{required ? " *" : ""} (JSON)</span><textarea className="developer-tool-json compact" spellCheck={false} value={typeof value === "object" ? stringify(value) : ""} onChange={(event) => { try { update(event.target.value ? JSON.parse(event.target.value) : undefined); } catch { update(event.target.value); } }} /></label>;
            return <label className="field" key={name}><span>{name}{required ? " *" : ""}</span>{property.type === "string" && (name === "svg" || name === "alt") ? <textarea value={String(value ?? "")} onChange={(event) => update(event.target.value)} /> : <input type={property.type === "number" || property.type === "integer" ? "number" : "text"} value={String(value ?? "")} onChange={(event) => update(property.type === "number" || property.type === "integer" ? Number(event.target.value) : event.target.value)} />}</label>;
          })}
        </div>
      )}
      <div className="settings-actions"><button className="primary-button" type="button" disabled={disabled || running || !selected} onClick={() => void invoke()}>{running ? "Running…" : `Run ${selected?.name ?? "tool"}`}</button></div>
      {disabled ? <span className="status-copy" role="status">The Live2D scene is not ready yet.</span> : null}
      {result ? <div className={`developer-tool-result ${result.kind}`} role={result.kind === "error" ? "alert" : "status"}><strong>{result.kind === "error" ? "Error" : "Result"}</strong><pre>{result.text}</pre></div> : null}
    </details>
  );
}
