pub(crate) fn enabled() -> bool {
    enabled_for(std::env::var("BUZZ_DISABLE_STARTER_AGENTS").ok().as_deref())
}

fn enabled_for(value: Option<&str>) -> bool {
    !value.is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

#[cfg(test)]
mod tests {
    use super::enabled_for;

    #[test]
    fn defaults_remain_enabled_without_an_explicit_opt_out() {
        for value in [None, Some(""), Some("0"), Some("false")] {
            assert!(enabled_for(value));
        }
    }

    #[test]
    fn explicit_opt_out_disables_starter_agents() {
        for value in [Some("1"), Some("true"), Some("TRUE")] {
            assert!(!enabled_for(value));
        }
    }
}
