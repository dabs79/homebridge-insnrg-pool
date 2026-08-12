import type { Characteristic } from 'homebridge';

/**
 * Safely retarget a numeric characteristic to a new range and value, even when
 * the new range is DISJOINT from the current one (e.g. a pH setpoint of
 * 6.8-8.0 vs TargetTemperature's default 10-38): neither value-then-setProps
 * nor setProps-then-value avoids illegal-value warnings there.
 *
 * Sequence: widen props to the union of old+new range → set the (clamped)
 * value, now valid → narrow props to the new range, with the value valid in it.
 */
export function setRangeAndValue(
  char: Characteristic,
  min: number,
  max: number,
  step: number,
  value: number,
): void {
  const clamped = Math.min(max, Math.max(min, value));
  const oldMin = typeof char.props.minValue === 'number' ? char.props.minValue : min;
  const oldMax = typeof char.props.maxValue === 'number' ? char.props.maxValue : max;
  char.setProps({ minValue: Math.min(oldMin, min), maxValue: Math.max(oldMax, max), minStep: step });
  char.updateValue(clamped);
  char.setProps({ minValue: min, maxValue: max, minStep: step });
}
