import { ButtonStyle, ComponentType, TextInputStyle } from './types';

// ---- Message components (Components V2) ----

export function container(children: unknown[]): unknown {
  return { type: ComponentType.Container, components: children };
}

export function text(content: string): unknown {
  return { type: ComponentType.TextDisplay, content };
}

export function separator(): unknown {
  return { type: ComponentType.Separator };
}

export interface ButtonSpec {
  customId: string;
  label: string;
  style?: number;
  disabled?: boolean;
}

export function button(spec: ButtonSpec): unknown {
  return {
    type: ComponentType.Button,
    custom_id: spec.customId,
    label: spec.label,
    style: spec.style ?? ButtonStyle.Secondary,
    disabled: spec.disabled ?? false,
  };
}

export function row(...buttons: unknown[]): unknown {
  return { type: ComponentType.ActionRow, components: buttons };
}

export interface MessageUserSelectSpec {
  customId: string;
  minValues: number;
  maxValues: number;
  placeholder?: string;
  /** Pre-selected users — supported on message components (not modals). */
  defaultUserIds?: string[];
}

/** A user-select menu for a message (wrap in row()). */
export function messageUserSelect(spec: MessageUserSelectSpec): unknown {
  const node: Record<string, unknown> = {
    type: ComponentType.UserSelect,
    custom_id: spec.customId,
    min_values: spec.minValues,
    max_values: spec.maxValues,
  };
  if (spec.placeholder) node.placeholder = spec.placeholder;
  if (spec.defaultUserIds && spec.defaultUserIds.length > 0) {
    node.default_values = spec.defaultUserIds.map((id) => ({ id, type: 'user' }));
  }
  return node;
}

// ---- Modal components ----

/** Label(18) wraps every labeled modal input since the Aug 2025 modal rework. */
export function label(lbl: string, component: unknown, description?: string): unknown {
  const node: Record<string, unknown> = { type: ComponentType.Label, label: lbl, component };
  if (description) node.description = description;
  return node;
}

export interface TextInputSpec {
  customId: string;
  required?: boolean;
  placeholder?: string;
  value?: string;
  maxLength?: number;
  paragraph?: boolean;
}

export function textInput(spec: TextInputSpec): unknown {
  const node: Record<string, unknown> = {
    type: ComponentType.TextInput,
    custom_id: spec.customId,
    style: spec.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
    required: spec.required ?? true,
  };
  if (spec.placeholder) node.placeholder = spec.placeholder;
  if (spec.value !== undefined) node.value = spec.value;
  if (spec.maxLength) node.max_length = spec.maxLength;
  return node;
}

export interface UserSelectSpec {
  customId: string;
  minValues: number;
  maxValues: number;
  required?: boolean;
}

export function userSelect(spec: UserSelectSpec): unknown {
  return {
    type: ComponentType.UserSelect,
    custom_id: spec.customId,
    min_values: spec.minValues,
    max_values: spec.maxValues,
    required: spec.required ?? true,
  };
}

export interface RadioOption {
  label: string;
  value: string;
  default?: boolean;
}

export function radioGroup(customId: string, options: RadioOption[]): unknown {
  return { type: ComponentType.RadioGroup, custom_id: customId, required: true, options };
}
