use demoviewer_pack::quant;

#[test]
fn position_rounds_and_saturates() {
    assert_eq!(quant::position(0.0), 0);
    assert_eq!(quant::position(-1234.5), -1235); // round half away from zero
    assert_eq!(quant::position(1234.49), 1234);
    assert_eq!(quant::position(40000.0), i16::MAX);
    assert_eq!(quant::position(-40000.0), i16::MIN);
    assert_eq!(quant::position(f32::NAN), 0);
}

#[test]
fn angle_is_hundredths_in_half_open_range() {
    assert_eq!(quant::angle(0.0), 0);
    assert_eq!(quant::angle(12.345), 1235);
    assert_eq!(quant::angle(-89.0), -8900);
    assert_eq!(quant::angle(180.0), 18000);
    assert_eq!(quant::angle(-180.0), 18000);
    assert_eq!(quant::angle(270.0), -9000);
    assert_eq!(quant::angle(350.0), -1000);
    assert_eq!(quant::angle(-450.0), -9000);
    assert_eq!(quant::angle(179.996), 18000);
    assert_eq!(quant::angle(-179.996), 18000); // rounds onto -18000, which the range excludes
    assert_eq!(quant::angle(f32::NAN), 0);
    assert_eq!(quant::angle(f32::INFINITY), 0);
    for deg in (-1000..=1000).map(|d| d as f32 * 0.77) {
        let q = quant::angle(deg);
        assert!(q > -18000 && q <= 18000, "{deg} -> {q}");
    }
}

#[test]
fn duck_scales_to_u8() {
    assert_eq!(quant::duck(0.0), 0);
    assert_eq!(quant::duck(1.0), 255);
    assert_eq!(quant::duck(0.5), 128);
    assert_eq!(quant::duck(-0.1), 0);
    assert_eq!(quant::duck(1.5), 255);
    assert_eq!(quant::duck(f32::NAN), 0);
}
