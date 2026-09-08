import * as React from "react";

/**
 * Stand-ins for the host MUI barrel, shared by the MiniMax conformance suites.
 *
 * They have to be more than passthrough divs: the views' behaviour lives in
 * `onClick`, `value`/`onChange` and `title`, so a stub that dropped those
 * would make every interaction test vacuous. Components are cached because
 * React reconciles on component identity — a fresh function per access would
 * remount the tree on every render and lose the editing state these tests are
 * about.
 */
export function createMuiStubs(): Record<string, unknown> {
  const cache = new Map<string, React.FunctionComponent<Record<string, never>>>();
  const build = (name: string): React.FunctionComponent<never> => {
    if (name === "TextField") {
      return ((props: {
        value?: string;
        label?: string;
        disabled?: boolean;
        onChange?: (event: unknown) => void;
        onKeyDown?: (event: unknown) => void;
        placeholder?: string;
      }) =>
        React.createElement("textarea", {
          value: props.value ?? "",
          placeholder: props.placeholder,
          // The real TextField renders `label` as the field's accessible name,
          // which is how the composer's section fields are addressed.
          "aria-label": props.label,
          // A disabled MUI field is greyed and refuses input; the stub has to
          // carry that or a read-only assertion would be vacuous.
          disabled: props.disabled,
          onChange: props.onChange,
          onKeyDown: props.onKeyDown,
        })) as React.FunctionComponent<never>;
    }
    if (name === "Button" || name === "IconButton") {
      return ((props: {
        children?: React.ReactNode;
        onClick?: () => void;
        disabled?: boolean;
      }) =>
        React.createElement(
          "button",
          { onClick: props.onClick, disabled: props.disabled },
          props.children,
        )) as React.FunctionComponent<never>;
    }
    if (name === "Tooltip") {
      return ((props: { children?: React.ReactNode; title?: unknown }) =>
        React.createElement(
          "span",
          { title: typeof props.title === "string" ? props.title : undefined },
          props.children,
        )) as React.FunctionComponent<never>;
    }
    if (name === "Chip") {
      return ((props: { label?: React.ReactNode }) =>
        React.createElement("span", null, props.label)) as React.FunctionComponent<never>;
    }
    if (name === "Alert") {
      return ((props: { children?: React.ReactNode; severity?: string }) =>
        React.createElement(
          "div",
          { role: "alert", "data-severity": props.severity },
          props.children,
        )) as React.FunctionComponent<never>;
    }
    return ((props: {
      children?: React.ReactNode;
      onClick?: () => void;
      onDoubleClick?: () => void;
    }) =>
      React.createElement(
        "div",
        { onClick: props.onClick, onDoubleClick: props.onDoubleClick },
        props.children,
      )) as React.FunctionComponent<never>;
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => {
      if (!cache.has(name)) {
        cache.set(
          name,
          build(name) as React.FunctionComponent<Record<string, never>>,
        );
      }
      return cache.get(name);
    },
  });
}
