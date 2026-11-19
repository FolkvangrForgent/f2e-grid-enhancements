// One raycast: walks the scene index along the ray and turns crossings into hits.
import {gridUnitPixels} from '../helpers/grid.js';
import {barriersSeenFrom, distanceToFace, distanceToSide, distanceToWall, ELEVATION_HAIR, thresholdReach} from './barrier-rules.js';
import {
	crossedSegmentEndSide,
	crossedSegmentStartSide,
	crossingT,
	EDGE_END_X,
	EDGE_END_Y,
	EDGE_NORMAL_X,
	EDGE_NORMAL_Y,
	EDGE_STRIDE,
	isCornerCrossing,
	isCountedCrossing,
	isPointInsideEdgesToward
} from './geometry.js';
import {getSceneIndex, KIND_REGION_SIDE, KIND_WALL, REGION_FACE_MASK, REGION_SIDE_MASK, UNIFORM_MASK} from './scene-index.js';
import {faceShadows, quadShadow, segmentMeetsTriangle, shadowFrame, unionOf} from './shadows.js';
import {DARKNESS_SOURCE_TYPES, LIGHT_SOURCE_TYPES, SOURCE_TYPES_MASK, sourceVolume} from './sources.js';
import {bitOfType, EMPTY_ARRAY} from './types.js';

// The axes a ray moves along: vertical faces need horizontal travel, horizontal faces vertical travel.
const AXIS_X = 1;
const AXIS_Y = 2;
const AXIS_Z = 4;

// Hidden keys on hits. SUB_T orders hits at exactly the same t: -2 an inside hit at the range start, -1 / 1 a horizontal
// face the hair moves earlier / later, (-0.5, 0.5) a corner crossing, 0 any other crossing, 2 an inside hit at the range
// end. TIE_BREAK then orders by primitive, so the result does not depend on the tree walk. WALL_VERTEX is the endpoint a
// limited wall is crossed exactly at.
const SUB_T = Symbol('subT');
const TIE_BREAK = Symbol('tieBreak');
const WALL_VERTEX = Symbol('wallVertex');

// the barriers each source volume sees, by static index (Query#barriersSeenBySource)
const barriersBySourceVolume = new WeakMap();

const isElevation = elevation => typeof elevation === 'number' && !Number.isNaN(elevation);

// The state of one raycast and the code that tests primitives against it. Reused from ray to ray (see idleQuery), and
// itself the `ray` BVH#visitAlongRay walks.
class Query {
	origin = new Float64Array(3);
	inverseDelta = new Float64Array(3);
	stackNodes = new Int32Array(64);
	stackEntryTs = new Float64Array(64);
	activeLevelFlags = new Uint8Array(8);

	run(scene, origin, destination, options = {}) {
		const {
			edgeRestrictionType = 'move',
			edgeDirectionMode = CONST.EDGE_DIRECTION_MODES.NORMAL,
			elevationBias = 'above',
			stop = false,
			useThreshold = true,
			externalRadius = 0,
			priority = -Infinity
		} = options;
		let {radius} = options;
		let {min: tMin = 0, max: tMax = 1} = options.range ?? {};
		const {walls = true, regions = true, tokens = true, levels = true, sources = true} = options.hits ?? {};
		const typeBit = (this.typeBit = bitOfType(edgeRestrictionType));
		if (!typeBit) throw new TypeError(`raycast: unknown edgeRestrictionType "${edgeRestrictionType}"`);
		const originX = (this.originX = origin.x);
		const originY = (this.originY = origin.y);
		if (!isElevation(origin.elevation)) throw new TypeError('raycast: origin.elevation must be a number');
		if (!isElevation(destination?.elevation)) throw new TypeError('raycast: destination.elevation must be a number');
		const originElevation = (this.originElevation = origin.elevation);
		const deltaX = (this.deltaX = destination.x - originX);
		const deltaY = (this.deltaY = destination.y - originY);
		const deltaElevation = (this.deltaElevation = destination.elevation - originElevation);
		const axes = (this.axes = (deltaX ? AXIS_X : 0) | (deltaY ? AXIS_Y : 0) | (deltaElevation ? AXIS_Z : 0));
		this.tMin = tMin = Math.max(0, tMin);
		this.tMax = this.rangeEnd = tMax = Math.min(1, tMax);
		if (!axes || tMin > tMax) return [];

		this.scene = scene;
		this.originPoint = origin;
		this.externalRadius = externalRadius;
		this.useThreshold = useThreshold;
		this.edgeDirectionMode = edgeDirectionMode;
		this.priority = priority;
		// in pixels, for thresholds and attenuation, which are measured in 3D
		this.rayLength = Math.hypot(deltaX, deltaY, deltaElevation * gridUnitPixels(scene.grid));
		if (!(radius >= 0)) radius = this.rayLength;
		this.radius = radius;
		this.edgeRestrictionType = edgeRestrictionType;
		this.destinationX = destination.x;
		this.destinationY = destination.y;
		this.origin[0] = originX;
		this.origin[1] = originY;
		this.origin[2] = originElevation;
		this.inverseDelta[0] = 1 / deltaX;
		this.inverseDelta[1] = 1 / deltaY;
		this.inverseDelta[2] = 1 / deltaElevation;
		this.isAbove = elevationBias === 'above';
		// lying a hair above (or below) itself, the ray meets a horizontal plane a hair later or earlier
		this.crossingMovesLater = this.isAbove === deltaElevation < 0;
		this.requestedLevels = options.activeLevels;
		this.activeLevelFlagsReady = false;
		this.tieBreak = -1;
		this.subT = 0;
		this.stop = stop;
		this.firstLimitedT = this.secondLimitedT = Infinity;
		const hits = (this.hits = []);
		const index = (this.index = getSceneIndex(scene));

		if (levels && axes & AXIS_Z) this.crossLevelPlanes();
		this.addVolumesContaining(tMin, false, regions, tokens);
		this.addVolumesContaining(tMax, true, regions, tokens);
		let staticMask = 0;
		if (axes & (AXIS_X | AXIS_Y)) staticMask |= (walls ? typeBit : 0) | (regions ? REGION_SIDE_MASK : 0);
		if (axes & AXIS_Z && regions) staticMask |= REGION_FACE_MASK;
		if (staticMask) index.bvh.visitAlongRay(this, staticMask, this.visitStaticPrimitive);
		if (tokens) index.tokens.bvh.visitAlongRay(this, UNIFORM_MASK, this.visitToken);
		if (sources && typeBit & SOURCE_TYPES_MASK) this.crossSources();

		hits.sort(compareHits);
		if (stop) {
			let keptCount = hits.length;
			while (keptCount && hits[keptCount - 1].t > this.tMax) keptCount--;
			hits.length = keptCount;
		}
		// The first limited crossing is let through and the next blocks. Limited walls joined at the point the ray passes
		// (a window drawn as two segments) are one crossing.
		const firstLimited = hits.find(hit => hit.blocking && hit.limited);
		if (!firstLimited) return hits;
		const sharedVertex = firstLimited[WALL_VERTEX];
		for (const hit of hits) {
			const vertex = hit[WALL_VERTEX];
			const joinsFirstLimited = hit.blocking && hit.limited && vertex && sharedVertex && vertex.x === sharedVertex.x && vertex.y === sharedVertex.y;
			if (hit !== firstLimited && !joinsFirstLimited) continue;
			hit.blocking = false;
			hit.forgiven = true;
		}
		return hits;
	}

	// Drop references to the scene and the caller's objects.
	release() {
		this.scene = this.originPoint = this.index = this.requestedLevels = this.hits = null;
	}

	addHit(hit) {
		hit[TIE_BREAK] = this.tieBreak;
		hit[SUB_T] = this.subT;
		this.subT = 0;
		this.hits.push(hit);
		if (this.stop && hit.blocking) this.lowerTMax(hit.t, hit.limited);
	}

	// Whether crossing a one-way boundary blocks: NORMAL blocks going in, REVERSED going out, BOTH either way.
	directionalBlocks(entering) {
		const modes = CONST.EDGE_DIRECTION_MODES;
		if (this.edgeDirectionMode === modes.BOTH) return true;
		return (this.edgeDirectionMode === modes.REVERSED) !== entering;
	}

	// Pull tMax in to the nearest possible final blocker, so the tree walk skips everything behind it. For limited
	// crossings that is the second distinct t (joined limited walls share a t).
	lowerTMax(t, limited) {
		if (!limited) {
			if (t < this.tMax) this.tMax = t;
			return;
		}
		if (t === this.firstLimitedT || t === this.secondLimitedT) return;
		if (t < this.firstLimitedT) {
			this.secondLimitedT = this.firstLimitedT;
			this.firstLimitedT = t;
		} else if (t < this.secondLimitedT) this.secondLimitedT = t;
		if (this.secondLimitedT < this.tMax) this.tMax = this.secondLimitedT;
	}

	// The point at t; a horizontal face's crossing passes its exact elevation.
	pointAt(t, elevation = this.originElevation + this.deltaElevation * t) {
		return {x: this.originX + this.deltaX * t, y: this.originY + this.deltaY * t, elevation};
	}

	horizontalFaceNormal() {
		return {x: 0, y: 0, z: this.deltaElevation < 0 ? 1 : -1};
	}

	// t where the ray crosses a segment seen from above, within (tMin, tMax], else NaN. Sets crossedSegment*Side.
	edgeCrossingT(startX, startY, endX, endY) {
		const t = crossingT(this.originX, this.originY, this.destinationX, this.destinationY, startX, startY, endX, endY);
		return t > this.tMin && t <= this.tMax ? t : NaN;
	}

	// t where the ray, a hair above or below itself, crosses a horizontal plane, within (tMin, tMax], else NaN. Exactly
	// at an end of the requested range the hair moves the crossing in or out of it.
	planeCrossingT(elevation, movesLater = this.crossingMovesLater) {
		const t = (elevation - this.originElevation) / this.deltaElevation;
		if (t === this.tMin) return movesLater ? t : NaN;
		if (t === this.rangeEnd) return movesLater ? NaN : t;
		return t > this.tMin && t <= this.tMax ? t : NaN;
	}

	// [bottom, top) above, (bottom, top] below; an inclusive top makes 'above' [bottom, top].
	isWithinHeight(elevation, bottom, top, topInclusive = false) {
		if (!this.isAbove) return bottom < elevation && elevation <= top;
		return bottom <= elevation && (topInclusive ? elevation <= top : elevation < top);
	}

	// A flag per level of index.levels: on for the requested levels, or all without a request. Worked out on first use.
	getActiveLevels() {
		if (this.activeLevelFlagsReady) return this.activeLevelFlags;
		const {levels, levelIndexById} = this.index;
		if (this.activeLevelFlags.length < levels.length) this.activeLevelFlags = new Uint8Array(levels.length);
		const activeLevels = this.activeLevelFlags;
		activeLevels.fill(this.requestedLevels ? 0 : 1);
		for (const levelId of this.requestedLevels ?? EMPTY_ARRAY) {
			const levelIndex = levelIndexById.get(levelId);
			if (levelIndex !== undefined) activeLevels[levelIndex] = 1;
		}
		this.activeLevelFlagsReady = true;
		return activeLevels;
	}

	// A document counts when it is on no level, or on an active one.
	isOnActiveLevel(levelIndexes) {
		if (!levelIndexes.length) return true;
		const activeLevels = this.getActiveLevels();
		for (const levelIndex of levelIndexes) if (activeLevels[levelIndex]) return true;
		return false;
	}

	crossLevelPlanes() {
		const activeLevels = this.getActiveLevels();
		const levels = this.index.levels;
		for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
			if (!activeLevels[levelIndex]) continue;
			const {bottom, top, document} = levels[levelIndex];
			this.crossLevelPlane(document, bottom);
			this.crossLevelPlane(document, top);
		}
	}

	crossLevelPlane(level, elevation) {
		// NaN for an unbounded end
		const t = this.planeCrossingT(elevation);
		if (Number.isNaN(t)) return;
		// the hair moves a point on a horizontal plane later or earlier along the ray
		this.subT = this.crossingMovesLater ? 1 : -1;
		this.addHit({
			type: 'level',
			document: level,
			t,
			point: this.pointAt(t, elevation),
			normal: this.horizontalFaceNormal(),
			blocking: false,
			limited: false
		});
	}

	// Crossings cannot tell a ray starting inside a region or token from one never touching it, so each one containing a
	// range end gets an extra hit there. A volume's hits then always alternate entering and leaving.
	addVolumesContaining(t, isRayEnd, regions, tokens) {
		this.containedT = t;
		this.containedIsRayEnd = isRayEnd;
		this.containedPoint = this.pointAt(t);
		const {x, y, elevation} = this.containedPoint;
		if (regions) this.index.regionVolumes.bvh.visitContaining(x, y, elevation, this.visitRegionVolume);
		if (tokens) this.index.tokens.bvh.visitContaining(x, y, elevation, this.visitTokenVolume);
	}

	addInsideHit(type, document, order) {
		const isRayEnd = this.containedIsRayEnd;
		this.tieBreak = order;
		this.subT = isRayEnd ? 2 : -2;
		this.addHit({
			type,
			document,
			t: this.containedT,
			point: {...this.containedPoint},
			normal: this.backAlongRayNormal(),
			blocking: false,
			limited: false,
			entering: !isRayEnd,
			inside: isRayEnd ? 'destination' : 'origin'
		});
	}

	visitRegionVolume = volumeIndex => {
		const volume = this.index.regionVolumes.primitives[volumeIndex];
		const point = this.containedPoint;
		if (point.x < volume.minX || point.x > volume.maxX || point.y < volume.minY || point.y > volume.maxY) return;
		if (!this.isWithinHeight(point.elevation, volume.bottom, volume.top, volume.topInclusive) || !this.isOnActiveLevel(volume.levelIndexes)) return;
		if (isPointInsideEdgesToward(volume.edges, point.x, point.y, this.deltaX, this.deltaY)) this.addInsideHit('region', volume.document, volumeIndex);
	};

	visitTokenVolume = tokenIndex => {
		const token = this.index.tokens.primitives[tokenIndex];
		const point = this.containedPoint;
		let isInside;
		if (token.ellipsoid) {
			// in the unit-sphere frame; exactly on the surface counts as inside when heading inward
			const {centerX, centerY, centerZ, radiusX, radiusY, radiusZ} = token.ellipsoid;
			const unitX = (point.x - centerX) / radiusX;
			const unitY = (point.y - centerY) / radiusY;
			const unitZ = (point.elevation - centerZ) / radiusZ;
			const distanceSquared = unitX * unitX + unitY * unitY + unitZ * unitZ;
			const headingOut = (unitX * this.deltaX) / radiusX + (unitY * this.deltaY) / radiusY + (unitZ * this.deltaElevation) / radiusZ;
			isInside = distanceSquared < 1 || (distanceSquared === 1 && headingOut < 0);
		} else isInside = this.isWithinHeight(point.elevation, token.bottom, token.top) && isPointInsideEdgesToward(token.edges, point.x, point.y, this.deltaX, this.deltaY);
		if (isInside) this.addInsideHit('token', token.document, this.index.regionVolumes.primitives.length + tokenIndex);
	};

	visitStaticPrimitive = primitiveIndex => {
		const primitive = this.index.primitives[primitiveIndex];
		this.tieBreak = primitiveIndex;
		switch (primitive.kind) {
			case KIND_WALL:
				return this.crossWall(primitive);
			case KIND_REGION_SIDE:
				if (this.isOnActiveLevel(primitive.levelIndexes)) this.crossPrismSides(primitive, 'region');
				return;
			default:
				return this.crossRegionFace(primitive);
		}
	};

	crossWall(wall) {
		// the cheap crossing test first: almost every candidate fails it
		const t = this.edgeCrossingT(wall.startX, wall.startY, wall.endX, wall.endY);
		if (Number.isNaN(t) || (wall.isDoor && wall.document.isOpen)) return;
		const isAtStart = crossedSegmentStartSide === 0;
		const isAtEnd = !isAtStart && crossedSegmentEndSide === 0;

		// one height range per level the wall is on; a ray along a floor meets the walls standing on it, not those below
		const elevation = this.originElevation + this.deltaElevation * t;
		const activeLevels = wall.levelIndexes.length ? this.getActiveLevels() : null;
		let crossedRange = null;
		for (const range of wall.heightRanges) {
			if (activeLevels && !activeLevels[range.levelIndex]) continue;
			if (this.isWithinHeight(elevation, range.bottom, range.top)) {
				crossedRange = range;
				break;
			}
		}
		if (!crossedRange) return;

		// one-way walls as core decides them (ClockwiseSweepPolygon#_testEdgeInclusion); thresholds in 3D (thresholdReach)
		const {edge, normalX, normalY} = wall;
		const directionModes = CONST.EDGE_DIRECTION_MODES;
		if (edge.direction && this.edgeDirectionMode !== directionModes.BOTH) {
			const side = edge.orientPoint(this.originPoint);
			if ((this.edgeDirectionMode === directionModes.NORMAL) === (side === edge.direction)) return;
		}
		let attenuationT = NaN;
		const type = this.edgeRestrictionType;
		const threshold = edge.threshold?.[type];
		if (this.useThreshold && threshold && edge[type] >= CONST.EDGE_SENSE_TYPES.PROXIMITY) {
			const reach = thresholdReach(edge[type], threshold, edge.threshold.attenuation, this.distanceToWall(wall, crossedRange), this.radius, this.externalRadius);
			// let through, unlimited; attenuated, the ray runs out at its reach, which blocks here if not past the wall
			if (reach === Infinity) return;
			if (reach !== null && reach / this.rayLength > t) attenuationT = reach / this.rayLength;
		}
		const isAttenuated = !Number.isNaN(attenuationT);

		const towardOrigin = normalX * this.deltaX + normalY * this.deltaY > 0 ? -1 : 1;
		const hit = {
			type: 'wall',
			document: wall.document,
			t,
			point: this.pointAt(t, elevation),
			normal: {x: normalX * towardOrigin, y: normalY * towardOrigin, z: 0},
			blocking: !isAttenuated,
			limited: !!(wall.limitedTypes & this.typeBit)
		};
		if (isAttenuated) hit.attenuated = true;
		if (hit.limited && (isAtStart || isAtEnd)) hit[WALL_VERTEX] = isAtStart ? {x: wall.startX, y: wall.startY} : {x: wall.endX, y: wall.endY};
		this.addHit(hit);
		if (isAttenuated && attenuationT <= this.tMax) this.addAttenuationHit(wall.document, attenuationT);
	}

	// Where an attenuated ray runs out: it blocks.
	addAttenuationHit(document, t) {
		this.addHit({
			type: 'attenuation',
			document,
			t,
			point: this.pointAt(t),
			normal: this.backAlongRayNormal(),
			blocking: true,
			limited: false
		});
	}

	// Unit vector back along the ray, elevation in pixels.
	backAlongRayNormal() {
		const deltaZ = this.deltaElevation * gridUnitPixels(this.scene.grid);
		const length = Math.hypot(this.deltaX, this.deltaY, deltaZ);
		return {x: -this.deltaX / length, y: -this.deltaY / length, z: -deltaZ / length};
	}

	// [entryT, exitT] where the ray's line meets an ellipsoid (equal for a tangent line), or null if it misses. Scaled to a
	// unit sphere, it is a*t^2 + 2*b*t + c = 0, with roots (-b -+ sqrt(b^2 - a*c)) / a.
	ellipsoidCrossingTs(centerX, centerY, centerZ, radiusX, radiusY, radiusZ) {
		const unitStartX = (this.originX - centerX) / radiusX;
		const unitStartY = (this.originY - centerY) / radiusY;
		const unitStartZ = (this.originElevation - centerZ) / radiusZ;
		const unitDeltaX = this.deltaX / radiusX;
		const unitDeltaY = this.deltaY / radiusY;
		const unitDeltaZ = this.deltaElevation / radiusZ;
		const a = unitDeltaX * unitDeltaX + unitDeltaY * unitDeltaY + unitDeltaZ * unitDeltaZ;
		const b = unitStartX * unitDeltaX + unitStartY * unitDeltaY + unitStartZ * unitDeltaZ;
		const c = unitStartX * unitStartX + unitStartY * unitStartY + unitStartZ * unitStartZ - 1;
		const discriminant = b * b - a * c;
		if (!(discriminant >= 0)) return null;
		const rootOfDiscriminant = Math.sqrt(discriminant);
		return [(-b - rootOfDiscriminant) / a, (-b + rootOfDiscriminant) / a];
	}

	// An ellipsoid's unit normal (its gradient, elevation in pixels); `towardOrigin` is 1 at an entry, -1 at an exit.
	ellipsoidNormal(point, centerX, centerY, centerZ, radiusX, radiusY, radiusZ, towardOrigin) {
		const gradientX = (point.x - centerX) / (radiusX * radiusX);
		const gradientY = (point.y - centerY) / (radiusY * radiusY);
		const gradientZ = (point.elevation - centerZ) / (radiusZ * radiusZ * gridUnitPixels(this.scene.grid));
		const scale = towardOrigin / (Math.hypot(gradientX, gradientY, gradientZ) || 1);
		return {x: gradientX * scale, y: gradientY * scale, z: gradientZ * scale};
	}

	// The vertical faces of a prism: a region side run or a token footprint. Tokens never block; a region side blocks or
	// limits only through barriers (region/barrier.js).
	crossPrismSides(prism, type) {
		const edges = prism.edges;
		for (let offset = 0; offset < edges.length; offset += EDGE_STRIDE) {
			const t = this.edgeCrossingT(edges[offset], edges[offset + 1], edges[offset + EDGE_END_X], edges[offset + EDGE_END_Y]);
			if (Number.isNaN(t)) continue;
			if (!isCountedCrossing()) continue;
			const isAtCorner = isCornerCrossing();
			const elevation = this.originElevation + this.deltaElevation * t;
			if (!this.isWithinHeight(elevation, prism.bottom, prism.top, prism.topInclusive)) continue;
			const point = this.pointAt(t, elevation);
			const normalX = edges[offset + EDGE_NORMAL_X];
			const normalY = edges[offset + EDGE_NORMAL_Y];
			const entering = normalX * this.deltaX + normalY * this.deltaY < 0;
			const towardOrigin = entering ? 1 : -1;
			// two edges counted at one corner are ordered as the shifted ray meets them, kept within (-0.5, 0.5)
			if (isAtCorner) {
				const cornerIsStart = crossedSegmentStartSide === 0;
				const alongX = cornerIsStart ? edges[offset + EDGE_END_X] - edges[offset] : edges[offset] - edges[offset + EDGE_END_X];
				const alongY = cornerIsStart ? edges[offset + EDGE_END_Y] - edges[offset + 1] : edges[offset + 1] - edges[offset + EDGE_END_Y];
				const alongRay = alongX * this.deltaX + alongY * this.deltaY;
				const towardSide = alongX * this.deltaY - alongY * this.deltaX;
				this.subT = Math.atan(alongRay / towardSide) / Math.PI;
			}
			const hit = {
				type,
				document: prism.document,
				t,
				point,
				normal: {x: normalX * towardOrigin, y: normalY * towardOrigin, z: 0},
				blocking: false,
				limited: false,
				entering
			};
			if (!prism.barriers?.length) {
				this.addHit(hit);
				continue;
			}
			const barrier = this.resolveBarriers(prism.barriers, entering, () => this.distanceToSide(prism, offset), t);
			if (barrier.normal || barrier.limited) {
				hit.blocking = true;
				hit.limited = !barrier.normal;
				hit.surface = barrier.normal ?? barrier.limited;
			}
			this.addBarrierHit(hit, barrier);
		}
	}

	crossRegionFace(face) {
		// an inclusive top sits a hair above its elevation (a flat region's single face does not)
		// higher than the ray's own hair, so the ray is always below it and crosses it later going up
		const isLifted = face.topInclusive && face.elevation === face.top && face.top > face.bottom;
		const movesLater = isLifted ? this.deltaElevation > 0 : this.crossingMovesLater;
		const t = this.planeCrossingT(face.elevation, movesLater);
		if (Number.isNaN(t) || !this.isOnActiveLevel(face.levelIndexes)) return;
		const point = this.pointAt(t, face.elevation);
		const nudge = movesLater ? 1 : -1;
		if (!isPointInsideEdgesToward(face.edges, point.x, point.y, this.deltaX, this.deltaY, nudge)) return;
		// down through the top or up through the bottom goes in; a flat region has no inside (a one-way barrier on one goes in
		// going down)
		const hasInside = face.top > face.bottom;
		const entering = hasInside ? (face.elevation === face.top) === this.deltaElevation < 0 : this.deltaElevation < 0;
		const barrier = face.barriers.length ? this.resolveBarriers(face.barriers, entering, () => this.distanceToFace(face), t) : null;
		// core's surfaces block the types they restrict, as do barriers restricting fully; a barrier only limiting limits
		const normalSurface = face.surfaces.find(entry => entry.types & this.typeBit)?.behavior ?? barrier?.normal ?? null;
		const limitedSurface = normalSurface ? null : (barrier?.limited ?? null);
		const hit = {
			type: 'region',
			document: face.document,
			t,
			point,
			normal: this.horizontalFaceNormal(),
			blocking: !!(normalSurface || limitedSurface),
			limited: !!limitedSurface,
			surface: normalSurface ?? limitedSurface
		};
		if (hasInside) hit.entering = entering;
		this.subT = nudge;
		this.addBarrierHit(hit, barrier);
	}

	// Add a region face or side hit; one let through by an attenuating barrier runs out further on, which blocks.
	addBarrierHit(hit, barrier) {
		const isAttenuated = !hit.blocking && !Number.isNaN(barrier?.attenuationT ?? NaN);
		if (isAttenuated) hit.attenuated = true;
		this.addHit(hit);
		if (isAttenuated && barrier.attenuationT <= this.tMax) this.addAttenuationHit(hit.document, barrier.attenuationT);
	}

	// What crossing some of this module's barriers (region/barrier.js) at t does for the ray's restriction type, as a wall
	// would: the barrier's behavior that blocks (`normal`) or limits (`limited`), and where a ray an attenuating barrier let
	// through runs out (`attenuationT`, NaN if none). `distance()` is the distance in pixels from the ray's origin to the
	// barriers' nearest point, for thresholds (see thresholdReach).
	resolveBarriers(barriers, entering, distance, t) {
		const result = {normal: null, limited: null, attenuationT: NaN};
		const type = this.edgeRestrictionType;
		const {NONE, LIMITED, PROXIMITY} = CONST.EDGE_SENSE_TYPES;
		for (const barrier of barriers) {
			const sense = barrier.senses[type] ?? NONE;
			if (sense === NONE || !this.barrierBlocksThisWay(barrier.direction, entering)) continue;
			const threshold = barrier.thresholds[type];
			if (this.useThreshold && threshold && sense >= PROXIMITY) {
				const reach = thresholdReach(sense, threshold, barrier.attenuation, distance(), this.radius, this.externalRadius);
				if (reach === Infinity) continue;
				// attenuated: the ray runs out at its reach (the nearest of them), or is restricted here if that is not past it
				const attenuationT = reach === null ? NaN : reach / this.rayLength;
				if (attenuationT > t) {
					if (!(attenuationT >= result.attenuationT)) result.attenuationT = attenuationT;
					continue;
				}
			}
			if (sense === LIMITED) result.limited ??= barrier.behavior;
			else result.normal ??= barrier.behavior;
		}
		return result;
	}

	// Whether a barrier blocks a crossing going in (`entering`) or out: one-way barriers block only their way, which
	// edgeDirectionMode reverses (REVERSED) or ignores (BOTH), as for one-way walls.
	barrierBlocksThisWay(direction, entering) {
		const modes = CONST.EDGE_DIRECTION_MODES;
		if (direction === 'both' || this.edgeDirectionMode === modes.BOTH) return true;
		return ((direction === 'in') === entering) !== (this.edgeDirectionMode === modes.REVERSED);
	}

	// From the ray's origin to the nearest point of a wall's crossed height range, in pixels: to the wall in plan, and up or
	// down to it when the origin is beyond its bottom or top.
	distanceToWall(wall, range, x = this.originX, y = this.originY, elevation = this.originElevation) {
		return distanceToWall(wall, range, x, y, elevation, gridUnitPixels(this.scene.grid));
	}

	// From the ray's origin to the nearest point of a region face, in pixels: straight up or down when above or below the
	// region, else to its outline.
	distanceToFace(face, x = this.originX, y = this.originY, elevation = this.originElevation) {
		return distanceToFace(face, x, y, elevation, gridUnitPixels(this.scene.grid), this.deltaX, this.deltaY);
	}

	// From the ray's origin to the nearest point of a region side, in pixels: to the side in plan, and up or down to it when
	// the origin is beyond the region's bottom or top.
	distanceToSide(prism, offset, x = this.originX, y = this.originY, elevation = this.originElevation) {
		return distanceToSide(prism, offset, x, y, elevation, gridUnitPixels(this.scene.grid));
	}

	visitToken = tokenIndex => {
		const token = this.index.tokens.primitives[tokenIndex];
		this.tieBreak = this.index.primitives.length + tokenIndex;
		// tokens never block: their hits only say where the ray enters and leaves them
		if (token.ellipsoid) return this.crossEllipsoid(token.ellipsoid, token.document);
		if (this.axes & (AXIS_X | AXIS_Y)) this.crossPrismSides(token, 'token');
		if (this.axes & AXIS_Z) {
			this.crossTokenFace(token, token.bottom);
			this.crossTokenFace(token, token.top);
		}
	};

	crossTokenFace(token, elevation) {
		const t = this.planeCrossingT(elevation);
		if (Number.isNaN(t)) return;
		const point = this.pointAt(t, elevation);
		const nudge = this.crossingMovesLater ? 1 : -1;
		if (!isPointInsideEdgesToward(token.edges, point.x, point.y, this.deltaX, this.deltaY, nudge)) return;
		this.subT = nudge;
		this.addHit({
			type: 'token',
			document: token.document,
			t,
			point,
			normal: this.horizontalFaceNormal(),
			blocking: false,
			limited: false,
			entering: (elevation === token.top) === this.deltaElevation < 0
		});
	}

	crossEllipsoid({centerX, centerY, centerZ, radiusX, radiusY, radiusZ}, document) {
		const crossingTs = this.ellipsoidCrossingTs(centerX, centerY, centerZ, radiusX, radiusY, radiusZ);
		if (!crossingTs) return;
		// entry then exit; a tangent ray gets both at one t
		for (const [rootIndex, t] of crossingTs.entries()) {
			const rootSign = rootIndex ? 1 : -1;
			if (!(t > this.tMin) || t > this.tMax) continue;
			const point = this.pointAt(t);
			this.addHit({
				type: 'token',
				document,
				t,
				point,
				normal: this.ellipsoidNormal(point, centerX, centerY, centerZ, radiusX, radiusY, radiusZ, -rootSign),
				blocking: false,
				limited: false,
				entering: rootSign < 0
			});
		}
	}

	// The viewed scene's darkness and priority light source volumes (see sources.js).
	crossSources() {
		if (!canvas?.ready || canvas.scene !== this.scene) return;
		const {darknessSources, lightSources} = canvas.effects;
		let order = this.index.primitives.length + this.index.tokens.primitives.length;
		this.segmentMinX = Math.min(this.originX, this.destinationX);
		this.segmentMaxX = Math.max(this.originX, this.destinationX);
		this.segmentMinY = Math.min(this.originY, this.destinationY);
		this.segmentMaxY = Math.max(this.originY, this.destinationY);
		if (this.typeBit & DARKNESS_SOURCE_TYPES) {
			for (const source of darknessSources) this.crossSourceVolume(sourceVolume(source, 'darkness', this.scene), order++);
		}
		if (this.typeBit & LIGHT_SOURCE_TYPES) {
			for (const source of lightSources) this.crossSourceVolume(sourceVolume(source, 'light', this.scene), order++);
		}
	}

	// A source volume is a sphere cut to the source's polygon (by other sources' edges; see sources.js) and to what barriers
	// hide from the source (sourceShadows). The ray is inside it in stretches, each starting and ending on the sphere, the
	// polygon or a shadow's edge; its boundary is one way (see directionalBlocks).
	crossSourceVolume(volume, order) {
		if (!volume || !(volume.types & this.typeBit) || volume.priority < this.priority) return;
		if (this.segmentMaxX < volume.minX || this.segmentMinX > volume.maxX || this.segmentMaxY < volume.minY || this.segmentMinY > volume.maxY) return;
		this.tieBreak = order;

		let sphereEntryT = -Infinity;
		let sphereExitT = Infinity;
		if (volume.sphere) {
			const {centerX, centerY, centerZ, radiusXY, radiusZ} = volume;
			const crossingTs = this.ellipsoidCrossingTs(centerX, centerY, centerZ, radiusXY, radiusXY, radiusZ);
			// a tangent line touches the sphere without going in
			if (!crossingTs || !(crossingTs[0] < crossingTs[1])) return;
			[sphereEntryT, sphereExitT] = crossingTs;
		}
		const fromT = Math.max(sphereEntryT, this.tMin);
		const toT = Math.min(sphereExitT, this.tMax);
		if (!(fromT < toT)) return;

		// the stretches inside the sphere and the polygon, each end marked by what it is on: 'sphere', a polygon side's
		// normal, or null at an end of the tested range (no hit there)
		const edges = volume.edges;
		const fromPoint = this.pointAt(fromT);
		let insideFrom = isPointInsideEdgesToward(edges, fromPoint.x, fromPoint.y, this.deltaX, this.deltaY) ? fromT : null;
		let fromBoundary = fromT === sphereEntryT && sphereEntryT > this.tMin ? 'sphere' : null;
		const stretches = [];
		if (this.axes & (AXIS_X | AXIS_Y)) {
			const crossings = [];
			for (let offset = 0; offset < edges.length; offset += EDGE_STRIDE) {
				const t = crossingT(this.originX, this.originY, this.destinationX, this.destinationY, edges[offset], edges[offset + 1], edges[offset + EDGE_END_X], edges[offset + EDGE_END_Y]);
				if (!(t > fromT) || t > toT) continue;
				if (!isCountedCrossing()) continue;
				const normalX = edges[offset + EDGE_NORMAL_X];
				const normalY = edges[offset + EDGE_NORMAL_Y];
				const entering = normalX * this.deltaX + normalY * this.deltaY < 0;
				const towardOrigin = entering ? 1 : -1;
				crossings.push({t, normal: {x: normalX * towardOrigin, y: normalY * towardOrigin, z: 0}, entering});
			}
			crossings.sort((first, second) => first.t - second.t);
			for (const {t, normal, entering} of crossings) {
				if (entering) {
					insideFrom = t;
					fromBoundary = normal;
				} else if (insideFrom !== null) {
					stretches.push({from: insideFrom, to: t, fromBoundary, toBoundary: normal});
					insideFrom = null;
				}
			}
		}
		if (insideFrom !== null) stretches.push({from: insideFrom, to: toT, fromBoundary, toBoundary: toT === sphereExitT ? 'sphere' : null});
		if (!stretches.length) return;

		// less what barriers hide from the source; a shadow's edges are boundaries too
		const shadows = this.sourceShadows(volume, stretches[0].from, stretches[stretches.length - 1].to);
		for (const stretch of stretches) {
			let {from, fromBoundary: startBoundary} = stretch;
			for (const [shadowFrom, shadowTo] of shadows) {
				if (shadowTo <= from || shadowFrom >= stretch.to) continue;
				if (shadowFrom > from) this.addSourceStretch(volume, from, shadowFrom, startBoundary, 'shadow');
				from = shadowTo;
				startBoundary = 'shadow';
			}
			if (from < stretch.to) this.addSourceStretch(volume, from, stretch.to, startBoundary, stretch.toBoundary);
		}
	}

	// The hits at the ends of a stretch inside a source volume (none at an end of the tested range).
	addSourceStretch(volume, from, to, fromBoundary, toBoundary) {
		for (const [t, boundary, entering] of [
			[from, fromBoundary, true],
			[to, toBoundary, false]
		]) {
			if (boundary === 'sphere') this.addSourceSphereHit(volume, t, entering);
			else if (boundary === 'shadow') this.addSourceHit(volume, t, this.pointAt(t), this.backAlongRayNormal(), entering);
			else if (boundary) this.addSourceHit(volume, t, this.pointAt(t), boundary, entering);
		}
	}

	// The stretches (as [fromT, toT], sorted) of the ray between fromT and toT that barriers hide from a source: those
	// restricting its own type (darkness for a darkness source, light for a priority light). Core cuts a source's area by
	// walls in plan; this is the same in 3D, by every barrier as seen from the source, with one-way, limited, threshold and
	// attenuation rules as for a ray from the source (a point hidden by a normal barrier, or by two limited ones).
	sourceShadows(volume, fromT, toT) {
		const {centerX: sx, centerY: sy, centerZ: sz} = volume;
		const frame = shadowFrame(sx, sy, sz, this.originX, this.originY, this.originElevation, this.deltaX, this.deltaY, this.deltaElevation);
		if (!frame) return EMPTY_ARRAY;
		const from = this.pointAt(fromT);
		const to = this.pointAt(toT);
		const minZ = Math.min(sz, from.elevation, to.elevation);
		const maxZ = Math.max(sz, from.elevation, to.elevation);
		// Heights are lowered a hair (ELEVATION_HAIR); unbounded ones are cut to just past the triangle (source, ray stretch) the
		// shadows fall in.
		const clampHeight = elevation => Math.min(Math.max(elevation, minZ - 1), maxZ + 1) - ELEVATION_HAIR;
		const events = [];
		const addShadows = (stretches, {kind, reach}) => {
			let hidden = unionOf(stretches);
			if (reach !== Infinity) hidden = this.beyondReach(hidden, sx, sy, sz, reach);
			for (const [shadowFrom, shadowTo] of hidden) {
				const low = Math.max(shadowFrom, fromT);
				const high = Math.min(shadowTo, toT);
				if (low < high) events.push([low, kind, 1], [high, kind, -1]);
			}
		};
		// what can hide part of the stretch lies within the triangle (source, stretch) seen from above
		const triangle = {x0: sx, y0: sy, x1: from.x, y1: from.y, x2: to.x, y2: to.y};
		const minX = Math.min(sx, from.x, to.x);
		const minY = Math.min(sy, from.y, to.y);
		const maxX = Math.max(sx, from.x, to.x);
		const maxY = Math.max(sy, from.y, to.y);
		const boxes = this.index.bvh.primitiveBoxes;
		for (const barrier of this.barriersSeenBySource(volume)) {
			const offset = barrier.primitiveIndex * 6;
			if (maxX < boxes[offset] || maxY < boxes[offset + 1] || maxZ < boxes[offset + 2] || minX > boxes[offset + 3] || minY > boxes[offset + 4] || minZ > boxes[offset + 5]) continue;
			if (barrier.faceEdges) {
				addShadows(faceShadows(frame, barrier.faceEdges, EDGE_STRIDE, EDGE_END_X, EDGE_END_Y, barrier.elevation), barrier.restriction);
				continue;
			}
			// doors are read live
			if (barrier.door?.isOpen) continue;
			const {ax, ay, bx, by} = barrier;
			if (!segmentMeetsTriangle(ax, ay, bx, by, triangle)) continue;
			addShadows([quadShadow(frame, ax, ay, bx, by, clampHeight(barrier.bottom), clampHeight(barrier.top))], barrier.restriction);
		}
		if (!events.length) return EMPTY_ARRAY;
		// in order along the ray, ends before starts at the same t; hidden while a normal shadow or two limited ones cover it
		events.sort((first, second) => first[0] - second[0] || first[2] - second[2]);
		const hidden = [];
		const counts = {normal: 0, limited: 0};
		let hiddenFrom = null;
		for (const [t, kind, change] of events) {
			counts[kind] += change;
			const isHidden = counts.normal > 0 || counts.limited > 1;
			if (isHidden && hiddenFrom === null) hiddenFrom = t;
			else if (!isHidden && hiddenFrom !== null) {
				if (t > hiddenFrom) hidden.push([hiddenFrom, t]);
				hiddenFrom = null;
			}
		}
		return unionOf(hidden);
	}

	// The barriers that can hide something from a source (those restricting its own type), each with its restriction as seen
	// from the source: which they are, and how they restrict, depends on the source alone, so they are worked out once per source
	// volume and static index rather than for every ray. Each is {primitiveIndex, restriction} and either a vertical barrier's
	// {ax, ay, bx, by, bottom, top, door} (a wall's height range, or a region side's edge) or a face's {faceEdges, elevation}.
	barriersSeenBySource(volume) {
		const prepared = barriersBySourceVolume.get(volume);
		if (prepared?.bvh === this.index.bvh) return prepared.barriers;
		const {centerX: x, centerY: y, centerZ: elevation, radiusXY, radiusZ, ownType: type} = volume;
		// within the polygon's bounds and the sphere's box (every ray stretch inside the volume is, and so the source's triangle)
		const bounds = [
			Math.max(volume.minX, x - radiusXY) - 1,
			Math.max(volume.minY, y - radiusXY) - 1,
			elevation - radiusZ - 1,
			Math.min(volume.maxX, x + radiusXY) + 1,
			Math.min(volume.maxY, y + radiusXY) + 1,
			elevation + radiusZ + 1
		];
		const barriers = barriersSeenFrom(this.index, {x, y, elevation, type, radius: radiusXY}, bounds);
		barriersBySourceVolume.set(volume, {bvh: this.index.bvh, barriers});
		return barriers;
	}

	// The parts of some stretches farther than `reach` (pixels) from a point: an attenuated barrier only hides beyond its
	// reach from the source.
	beyondReach(stretches, x, y, elevation, reach) {
		const crossingTs = this.ellipsoidCrossingTs(x, y, elevation, reach, reach, reach / gridUnitPixels(this.scene.grid));
		if (!crossingTs) return stretches;
		const [nearT, farT] = crossingTs;
		const beyond = [];
		for (const [from, to] of stretches) {
			if (from < nearT) beyond.push([from, Math.min(to, nearT)]);
			if (to > farT) beyond.push([Math.max(from, farT), to]);
		}
		return beyond;
	}

	addSourceSphereHit(volume, t, entering) {
		const point = this.pointAt(t);
		const {centerX, centerY, centerZ, radiusXY, radiusZ} = volume;
		this.addSourceHit(volume, t, point, this.ellipsoidNormal(point, centerX, centerY, centerZ, radiusXY, radiusXY, radiusZ, entering ? 1 : -1), entering);
	}

	addSourceHit(volume, t, point, normal, entering) {
		this.addHit({
			type: volume.kind,
			document: volume.document,
			source: volume.source,
			t,
			point,
			normal,
			blocking: this.directionalBlocks(entering),
			limited: false,
			entering
		});
	}
}

// The query free to use; a re-entrant raycast makes its own.
let idleQuery = null;
const compareHits = (a, b) => a.t - b.t || (a[SUB_T] ?? 0) - (b[SUB_T] ?? 0) || a[TIE_BREAK] - b[TIE_BREAK];

function runQuery(scene, origin, destination, options) {
	const query = idleQuery ?? new Query();
	idleQuery = null;
	try {
		return query.run(scene, origin, destination, options);
	} finally {
		query.release();
		idleQuery = query;
	}
}

// The most recent raycasts' static hits (walls, regions and levels) are kept per scene (scene-index.js RayCache); the index
// drops them when it is rebuilt or a door changes. A cache miss casts the whole ray once and keeps its static hits; a hit
// casts only for tokens and sources and merges them in.

// What a raycast's static hits depend on: the segment and every option but `priority` (sources only) and `hits.tokens`
// and `hits.sources`.
function rayCacheKey(origin, destination, options) {
	const {walls = true, regions = true, levels = true} = options.hits ?? {};
	const activeLevels = options.activeLevels ? Array.from(options.activeLevels).join(',') : '*';
	return `${origin.x},${origin.y},${origin.elevation}>${destination.x},${destination.y},${destination.elevation}|${options.edgeRestrictionType}|${options.edgeDirectionMode}|${options.elevationBias}|${!!options.stop}|${options.useThreshold}|${options.externalRadius}|${options.radius}|${options.range?.min},${options.range?.max}|${walls}${regions}${levels}|${activeLevels}`;
}

// Hits found afresh on every call: tokens move all the time, and light and darkness sources are read live.
const LIVE_HIT_TYPES = new Set(['token', 'darkness', 'light']);

// Every crossing of the segment origin -> destination ({x, y, elevation}, elevation required), nearest first. API.md
// documents the options and hits. Hits of walls, regions and levels may be shared with other calls: they are frozen.
export function raycast(scene, origin, destination, options = {}) {
	const {tokens = true, sources = true} = options.hits ?? {};
	const cache = getSceneIndex(scene).rayCache;
	const key = rayCacheKey(origin, destination, options);
	const cachedHits = cache.get(key);
	if (cachedHits === undefined) {
		const hits = runQuery(scene, origin, destination, options);
		const staticHits = hits.filter(hit => !LIVE_HIT_TYPES.has(hit.type));
		// frozen whether cached or not, so they behave the same on every call
		for (const hit of staticHits) {
			Object.freeze(hit.point);
			Object.freeze(hit.normal);
			Object.freeze(hit);
		}
		// with `stop`, a blocking source may have cut the static hits short: only a complete set is cached
		const isCutByLiveHit = options.stop && hits.some(hit => hit.blocking && LIVE_HIT_TYPES.has(hit.type));
		if (!isCutByLiveHit) cache.set(key, staticHits);
		return hits;
	}
	const hits = cachedHits.slice();
	if (!tokens && !sources) return hits;
	const liveHits = runQuery(scene, origin, destination, {...options, hits: {walls: false, regions: false, levels: false, tokens, sources}});
	if (!liveHits.length) return hits;
	// Tokens never block and sources are never limited, so the static hits' limited crossings stand as they are; merged in
	// order, with `stop` the result ends at the first blocker of either (crossings at its t kept).
	hits.push(...liveHits);
	hits.sort(compareHits);
	if (options.stop) {
		const firstBlocker = hits.find(hit => hit.blocking);
		if (firstBlocker) {
			let keptCount = hits.length;
			while (hits[keptCount - 1].t > firstBlocker.t) keptCount--;
			hits.length = keptCount;
		}
	}
	return hits;
}
