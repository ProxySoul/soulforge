# UI primitives — "Premium Hearth" base

Single source of truth for popup/modal/settings design in SoulForge.

## Visual grammar

| Element         | Style                              | Use for                          |
| --------------- | ---------------------------------- | -------------------------------- |
| **`[Enter]`**   | Bracketed key cap                  | Every keyboard hint              |
| **Button**      | Rounded border row, focused brand  | Actions (Save, Install, Connect) |
| **Toggle**      | `[●━]` / `[━●]` + ON/OFF           | Boolean feature flags            |
| **Checkbox**    | `[✓]` / `[ ]`                      | Multi-select items               |
| **Radio**       | `(●)` / `( )`                      | Single choice in a group         |
| **Field**       | `label  value` + optional keyhint  | Read-only or inline-editable     |
| **Section**     | Title + description + body         | Group related controls           |
| **StatusPill**  | `● LABEL`, color-coded             | Live state indicator             |
| **Hint**        | `· italic muted`                   | Tips below controls              |
| **Flash**       | `✓ Saved` / `✗ Error`              | Transient confirmation           |

**Focus indicator:** leading `▸` + brand color label + bold. Single rule across every control.

## Base popup shell

```tsx
import { PremiumPopup, Section, Toggle, Field, StatusPill, Button } from "@/components/ui";

<PremiumPopup
  visible={open}
  width={120}
  height={36}
  title="Hearth"
  titleIcon="⌂"
  tabs={[
    { id: "surfaces", label: "Surfaces", icon: "network", blurb: "Bots · tokens · chats" },
    { id: "daemon",   label: "Daemon",   icon: "bolt",    blurb: "Lifecycle · health", status: "online" },
    { id: "pairings", label: "Pairings", icon: "key",     blurb: "Chats bound per surface" },
    { id: "logs",     label: "Logs",     icon: "plan",    blurb: "Live tail · filter" },
  ]}
  activeTab={tab}
  sidebarFooter={<StatusPill status="online" label="up 2h 14m" />}
  footerHints={[
    { key: "↑↓",    label: "nav" },
    { key: "Enter", label: "select" },
    { key: "Tab",   label: "switch" },
    { key: "Esc",   label: "close" },
  ]}
  flash={flash}
>
  <Section title="Active surface" description="Route messages from chats to this agent.">
    <Toggle label="Telegram"  on={true}  description="Long-poll bot · works anywhere" />
    <Toggle label="Discord"   on={false} description="Gateway · requires MESSAGE_CONTENT intent" />
    <Field  label="Chat ID"   value="123456" keyHint="Enter" focused />
    <Button label="Install daemon" keyHint="d" focused />
  </Section>
</PremiumPopup>
```

## Copy rules

- **Titles:** `Active surface`, `Allowed chats` — sentence case, no trailing period
- **Descriptions:** ≤ 8 words, present tense, no marketing fluff
- **Blurbs:** ≤ 5 words, `·` separators, descriptive not imperative
- **Key hints:** imperative verb (`nav`, `save`, `close`), lowercase

## Don't

- ❌ Don't wrap keys in `<...>` or ``...`` — always `[Enter]`, `[Ctrl+S]`
- ❌ Don't mix button styles within one popup
- ❌ Don't use raw `<text>` for keyboard hints — always `KeyCap` / `KeyCaps`
- ❌ Don't put more than one focus indicator on screen at a time
- ❌ Don't write descriptions longer than one line
