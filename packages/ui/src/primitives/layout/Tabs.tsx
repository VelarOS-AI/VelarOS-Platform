/**
 * 标签页容器（基于 Radix Tabs）。
 *
 * 样式：`.velar-tabs-list` · 见 styles/components/。
 */
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef, type ReactElement } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '../../lib/cn'
const Tabs = TabsPrimitive.Root

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref): ReactElement => (
  <TabsPrimitive.List
    ref={ref}
    data-slot="tabs-list"
    className={cn('velar-tabs-list', className)}
    {...props}
  />
))

TabsList.displayName = TabsPrimitive.List.displayName

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref): ReactElement => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn('velar-tabs-trigger', className)}
    {...props}
  />
))

TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref): ReactElement => (
  <TabsPrimitive.Content
    ref={ref}
    data-slot="tabs-content"
    className={cn('velar-tabs-content', className)}
    {...props}
  />
))

TabsContent.displayName = TabsPrimitive.Content.displayName

export {
  Tabs,
}
