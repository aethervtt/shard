# Localize text

String tables are `locales/<locale>.strings.json` (schema `.shard/schemas/strings.schema.json`),
one per locale, named by BCP 47 tag:

```json
{ "hud.fuel": "Fuel: {amount}%", "items.count": { "one": "{n} item", "other": "{n} items" } }
```

- Give text a key instead of (or besides) its text: `"ui/UiText": { "key": "hud.fuel", "params":
  { "amount": 100 } }`. `text/Text` and `text/ScreenText` take `key` and `params` too. The
  translated string shows, and follows locale switches on the next frame. `text` shows until the
  key resolves.
- Update a parameter from a system: `world.set(label, UiText, { params: { amount: pct } })`.
- Code: `tr(world, 'items.count', { n: 3 })`. Plural forms (zero, one, two, few, many, other) are
  picked by `n` (or `count`) with `Intl.PluralRules`; numbers format with `Intl.NumberFormat`.
- Switch: `setLocale(world, 'pt-BR')`, or `locale.set` from a tool. `pt-BR` falls back to `pt`,
  then `text/Locale`'s `fallback` (`en`). The choice persists in `engine/Settings`.

Check it: `shard validate` reports keys a locale lacks, `{params}` that differ between locales,
and keys scenes and prefabs use that no table defines. At runtime, `locale.missing` lists what
didn't resolve, and `ui_describe` shows each node's `key` and translated `text`.
