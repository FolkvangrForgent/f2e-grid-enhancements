
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn ellipsoid_line_distance(ellipsoid_scale_x: f32, ellipsoid_scale_y: f32, ellipsoid_scale_z: f32, ellipsoid_position_x: f32, ellipsoid_position_y: f32, ellipsoid_position_z: f32, ellipsoid_rotation_x: f32, ellipsoid_rotation_y: f32, ellipsoid_rotation_z: f32, line_width: f32, line_height: f32, line_position_x: f32, line_position_y: f32, line_position_z: f32, line_rotation_x: f32, line_rotation_y: f32, line_rotation_z: f32) -> f32 {
	// setup ellipsoid
	let ellipsoid_scale = parry3d::na::Vector3::new(ellipsoid_scale_x, ellipsoid_scale_y, ellipsoid_scale_z);
	let ellipsoid_position = parry3d::na::Vector3::new(ellipsoid_position_x, ellipsoid_position_y, ellipsoid_position_z);
	let ellipsoid_rotation = parry3d::na::Vector3::new(ellipsoid_rotation_x, ellipsoid_rotation_y, ellipsoid_rotation_z);
	let ellipsoid_isometry = parry3d::na::Isometry3::new(ellipsoid_position, ellipsoid_rotation);
	match parry3d::shape::Ball::new(1.0).scaled(&ellipsoid_scale, 64) {
		Some(ellipsoid_shape) => {
			parry3d::either::for_both!(ellipsoid_shape, ellipsoid_shape_resolved => {
				// setup cone
				let line_position = parry3d::na::Vector3::new(line_position_x, line_position_y, line_position_z);
				let line_rotation = parry3d::na::Vector3::new(line_rotation_x, line_rotation_y, line_rotation_z );
				let line_isometry = parry3d::na::Isometry3::new(line_position, line_rotation);
				let line_shape = parry3d::shape::Cylinder::new(line_height / 2.0, line_width / 2.0);
				// lengthy intersection check
				match parry3d::query::distance(&ellipsoid_isometry, &ellipsoid_shape_resolved, &line_isometry, &line_shape) {
					Ok(distance) => {
						return distance;
					},
					Err(_) => {}
				}
			});
		},
		None => {}
	}
	return std::f32::INFINITY;
}

#[wasm_bindgen]
pub fn ellipsoid_cone_distance(ellipsoid_scale_x: f32, ellipsoid_scale_y: f32, ellipsoid_scale_z: f32, ellipsoid_position_x: f32, ellipsoid_position_y: f32, ellipsoid_position_z: f32, ellipsoid_rotation_x: f32, ellipsoid_rotation_y: f32, ellipsoid_rotation_z: f32, cone_internal_angle: f32, cone_height: f32, cone_position_x: f32, cone_position_y: f32, cone_position_z: f32, cone_rotation_x: f32, cone_rotation_y: f32, cone_rotation_z: f32) -> f32 {
	// setup ellipsoid
	let ellipsoid_scale = parry3d::na::Vector3::new(ellipsoid_scale_x, ellipsoid_scale_y, ellipsoid_scale_z);
	let ellipsoid_position = parry3d::na::Vector3::new(ellipsoid_position_x, ellipsoid_position_y, ellipsoid_position_z);
	let ellipsoid_rotation = parry3d::na::Vector3::new(ellipsoid_rotation_x, ellipsoid_rotation_y, ellipsoid_rotation_z);
	let ellipsoid_isometry = parry3d::na::Isometry3::new(ellipsoid_position, ellipsoid_rotation);
	match parry3d::shape::Ball::new(1.0).scaled(&ellipsoid_scale, 64) {
		Some(ellipsoid_shape) => {
			parry3d::either::for_both!(ellipsoid_shape, ellipsoid_shape_resolved => {
				// setup cone
				let cone_position = parry3d::na::Vector3::new(cone_position_x, cone_position_y, cone_position_z - cone_height); // flip cone to point outwards
				let cone_rotation = parry3d::na::Vector3::new(cone_rotation_x, cone_rotation_y, cone_rotation_z + std::f32::consts::PI); // flip cone to point outwards
				let cone_isometry = parry3d::na::Isometry3::new(cone_position, cone_rotation);
				let cone_shape = parry3d::shape::Cone::new(cone_height / 2.0, cone_height * f32::sin(cone_internal_angle));
				// lengthy intersection check
				match parry3d::query::distance(&ellipsoid_isometry, &ellipsoid_shape_resolved, &cone_isometry, &cone_shape) {
					Ok(distance) => {
						return distance;
					},
					Err(_) => {}
				}
			});
		},
		None => {}
	}
	return std::f32::INFINITY;
}

#[wasm_bindgen]
pub fn ellipsoid_ellipsoid_distance(ellipsoid_1_scale_x: f32, ellipsoid_1_scale_y: f32, ellipsoid_1_scale_z: f32, ellipsoid_1_position_x: f32, ellipsoid_1_position_y: f32, ellipsoid_1_position_z: f32, ellipsoid_1_rotation_x: f32, ellipsoid_1_rotation_y: f32, ellipsoid_1_rotation_z: f32, ellipsoid_2_scale_x: f32, ellipsoid_2_scale_y: f32, ellipsoid_2_scale_z: f32, ellipsoid_2_position_x: f32, ellipsoid_2_position_y: f32, ellipsoid_2_position_z: f32, ellipsoid_2_rotation_x: f32, ellipsoid_2_rotation_y: f32, ellipsoid_2_rotation_z: f32) -> f32 {
	// setup ellipsoid 1
	let ellipsoid_1_scale = parry3d::na::Vector3::new(ellipsoid_1_scale_x, ellipsoid_1_scale_y, ellipsoid_1_scale_z);
	let ellipsoid_1_position = parry3d::na::Vector3::new(ellipsoid_1_position_x, ellipsoid_1_position_y, ellipsoid_1_position_z);
	let ellipsoid_1_rotation = parry3d::na::Vector3::new(ellipsoid_1_rotation_x, ellipsoid_1_rotation_y, ellipsoid_1_rotation_z);
	let ellipsoid_1_isometry = parry3d::na::Isometry3::new(ellipsoid_1_position, ellipsoid_1_rotation);
	match parry3d::shape::Ball::new(1.0).scaled(&ellipsoid_1_scale, 64) {
		Some(ellipsoid_1_shape) => {
			parry3d::either::for_both!(ellipsoid_1_shape, ellipsoid_1_shape_resolved => {
				// setup ellipsoid 2
				let ellipsoid_2_scale = parry3d::na::Vector3::new(ellipsoid_2_scale_x, ellipsoid_2_scale_y, ellipsoid_2_scale_z);
				let ellipsoid_2_position = parry3d::na::Vector3::new(ellipsoid_2_position_x, ellipsoid_2_position_y, ellipsoid_2_position_z);
				let ellipsoid_2_rotation = parry3d::na::Vector3::new(ellipsoid_2_rotation_x, ellipsoid_2_rotation_y, ellipsoid_2_rotation_z);
				let ellipsoid_2_isometry = parry3d::na::Isometry3::new(ellipsoid_2_position, ellipsoid_2_rotation);
				match parry3d::shape::Ball::new(1.0).scaled(&ellipsoid_2_scale, 64) {
					Some(ellipsoid_2_shape) => {
						parry3d::either::for_both!(ellipsoid_2_shape, ellipsoid_2_shape_resolved => {
							// lengthy intersection check
							match parry3d::query::distance(&ellipsoid_1_isometry, &ellipsoid_1_shape_resolved, &ellipsoid_2_isometry, &ellipsoid_2_shape_resolved) {
								Ok(distance) => {
									return distance;
								},
								Err(_) => {}
							}
						});
					},
					None => {}
				}
			});
		},
		None => {}
	}
	return std::f32::INFINITY;
}