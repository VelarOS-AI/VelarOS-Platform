/**
 * 下拉选择，基于 Radix Select。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | bare`；`size` = `default | sm | xs`。
 * 样式：`.velar-select-trigger` · 见 styles/components/。
 */
import { memo, type ReactElement, type ReactNode, useMemo } from "react";
import {
  CaretDownIcon,
  CheckIcon,
  QuestionMarkIcon,
} from "@phosphor-icons/react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";
import { isPresent, toNullable } from "../../lib/runtime";
import { BubbleTooltip } from "../overlays/Tooltip";

const selectVariants = cva("velar-select-trigger", {
  variants: {
    variant: {
      default: "velar-select-variant-default",
      bare: "velar-select-variant-bare",
    },
    size: {
      default: "velar-select-size-default",
      sm: "velar-select-size-sm",
      xs: "velar-select-size-xs",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  /** Optional long-form explanation rendered behind a right-side help icon. */
  help?: string;
  disabled?: boolean;
  icon?: ReactNode;
  tone?: "danger";
}

export interface SelectProps<T extends string = string> extends VariantProps<
  typeof selectVariants
> {
  value?: LooseOptional<T>;
  options: Array<SelectOption<T>>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Forwarded to the trigger for pairing with `<Label htmlFor={id}>`. */
  id?: string;
  onChange: (value: T) => void;
}

function SelectImpl<T extends string>({
  value,
  options,
  placeholder,
  disabled = false,
  className,
  id,
  variant,
  size,
  onChange,
}: SelectProps<T>): ReactElement {
  const resolvedSize = size ?? "default";
  const iconSize = resolvedSize === "xs" ? 14 : 16;
  const sideOffset = resolvedSize === "xs" ? 8 : 10;
  let normalizedValue: T | undefined;
  if (!isPresent(value)) {
    normalizedValue = undefined;
  } else {
    normalizedValue = value;
  }

  const selected = useMemo(
    () =>
      toNullable(options.find((option) => option.value === normalizedValue)),
    [options, normalizedValue],
  );

  return (
    <SelectPrimitive.Root
      value={normalizedValue}
      disabled={disabled}
      onValueChange={(next) => onChange(next as T)}
    >
      <SelectPrimitive.Trigger
        id={id}
        data-slot="select-trigger"
        data-tone={selected?.tone}
        className={cn(
          selectVariants({ variant, size: resolvedSize }),
          className,
        )}
        aria-label={selected?.label ?? placeholder}
      >
        <span className={"velar-select-trigger-content"}>
          {!!selected?.icon && (
            <span className={"velar-select-trigger-icon"}>{selected.icon}</span>
          )}
          <SelectPrimitive.Value placeholder={placeholder}>
            {selected?.label ?? placeholder}
          </SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon className={"velar-select-trigger-caret"}>
          <CaretDownIcon size={iconSize} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-slot="select-content"
          data-size={resolvedSize}
          className={"velar-select-content"}
          position="popper"
          sideOffset={sideOffset}
        >
          <SelectPrimitive.Viewport className={"velar-select-viewport"}>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                data-tone={option.tone}
                className={"velar-select-item"}
              >
                <span className={"velar-select-item-content"}>
                  {!!option.icon && (
                    <span className={"velar-select-item-icon"}>
                      {option.icon}
                    </span>
                  )}
                  <span className={"velar-select-item-meta"}>
                    <SelectPrimitive.ItemText asChild>
                      <span className={"velar-select-item-label"}>
                        {option.label}
                      </span>
                    </SelectPrimitive.ItemText>
                    {!!option.description && (
                      <span className={"velar-select-item-description"}>
                        {option.description}
                      </span>
                    )}
                  </span>
                </span>
                {!!option.help && (
                  <BubbleTooltip
                    content={
                      <span className={"velar-select-item-help-tip"}>
                        {option.help}
                      </span>
                    }
                    ariaLabel={option.help}
                    side="right"
                    align="center"
                    sideOffset={8}
                  >
                    <span
                      className={"velar-select-item-help"}
                      tabIndex={0}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <QuestionMarkIcon size={11} weight="bold" />
                    </span>
                  </BubbleTooltip>
                )}
                <SelectPrimitive.ItemIndicator
                  className={"velar-select-item-indicator"}
                >
                  <CheckIcon size={iconSize} weight="bold" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export const Select = memo(SelectImpl) as <T extends string>(
  props: SelectProps<T>,
) => ReactElement;
(Select as { displayName?: string }).displayName = "Select";
