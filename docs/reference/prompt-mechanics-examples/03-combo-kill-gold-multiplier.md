# Example 03: Combo Kill Gold Multiplier + UI

## Prompt
"A multiplier to the base gold increment based on how many units are killed in combo, 0.5s apart."

## Classification
- Types: `mechanics`, `ui`
- Tier: economy mechanic with player feedback surface
- Suggested cost: `100,000` to `500,000` gold/credits

## Expected Runtime Additions
- Combo window tracker (`0.5s` chaining)
- Gold multiplier curve + caps
- UI indicator for active combo level and payout multiplier

## Notes
- This adds high expression and can accelerate economy, so hard caps and telemetry are required.
