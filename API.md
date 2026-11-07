# API

```js
const api = game.modules.get('f2e-grid-enhancements').api;
```

## `raycast(scene, origin, destination, [options])`

This module exposes a 3D raycasting helper that can do both surface and wall collisions at the same time. Walls are constrained to the elevation ranges of the levels they occupy.

### Parameters

| Parameter     | Type            | Description       |
| ------------- | --------------- | ----------------- |
| `scene`       | `Scene`         | Scene to raycast  |
| `origin`      | `ElevatedPoint` | Start of the ray  |
| `destination` | `ElevatedPoint` | End of the ray    |
| `options`     | `object`        | Optional settings |

### Options

| Option     | Type               | Default  | Description                                                |
| ---------- | ------------------ | -------- | ---------------------------------------------------------- |
| `type`     | `string`           | `'move'` | Wall restriction type                                      |
| `mode`     | `string`           | `'any'`  | Function return type: `'any'` or `'closest'` or `'all'`    |
| `walls`    | `boolean`          | `true`   | Collide with walls                                         |
| `surfaces` | `boolean`          | `true`   | Collide with surfaces                                      |
| `tMin`     | `number`           | `0`      | Start of the segment to test: `0` to `1`                   |
| `tMax`     | `number`           | `1`      | End of the segment to test: `0` to `1`                     |
| `side`     | `string \| null`   | `null`   | Side of a surface the origin is on: `'above'` or `'below'` |
| `levels`   | `string[] \| null` | `null`   | Level identifiers to restrict collisions to                |

### Returns

| Mode        | Type                |
| ----------- | ------------------- |
| `'any'`     | `boolean`           |
| `'closest'` | `Collision \| null` |
| `'all'`     | `Collision[]`       |

#### `Collision`

| Property   | Type             | Description                            |
| ---------- | ---------------- | -------------------------------------- |
| `type`     | `string`         | What was hit: `'wall'` or `'surface'`  |
| `document` | `Wall \| Region` | The related wall or region document    |
| `t`        | `number`         | Position along the segment: `0` to `1` |
| `point`    | `ElevatedPoint`  | The point of the collision             |
