/// Combinations that Windows or common developer tools already use. Rejected up front so a
/// user-configured shortcut never silently shadows them.
const RESERVED: &[(&[&str], &str)] = &[
    (&["alt"], "f4"),
    (&["alt"], "tab"),
    (&["alt"], "escape"),
    (&["ctrl", "alt"], "delete"),
    (&["ctrl", "alt"], "tab"),
    (&["ctrl", "shift"], "escape"),
    (&["ctrl", "alt"], "escape"),
    (&["super"], "l"),
    (&["super"], "d"),
];

fn modifier(token: &str) -> Option<&'static str> {
    match token {
        "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" | "commandorctrl" => Some("ctrl"),
        "alt" | "option" => Some("alt"),
        "shift" => Some("shift"),
        "super" | "win" | "windows" | "meta" | "cmd" | "command" => Some("super"),
        _ => None,
    }
}

/// Validate a user-chosen global shortcut. Returns the trimmed accelerator.
///
/// Rules: at least two modifiers (so plain typing and single-modifier app chords are never
/// hijacked), no Ctrl+Shift+letter/digit chords (collide with browsers and IDEs), exactly one
/// non-modifier key, and nothing from the reserved list.
pub(crate) fn validate_accelerator(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Enter a shortcut such as Ctrl+Alt+F9".into());
    }
    let mut modifiers: Vec<&'static str> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for token in trimmed
        .split('+')
        .map(|token| token.trim().to_ascii_lowercase())
    {
        if token.is_empty() {
            return Err("The shortcut contains an empty key".into());
        }
        match modifier(&token) {
            Some(name) => {
                if modifiers.contains(&name) {
                    return Err("The shortcut repeats a modifier key".into());
                }
                modifiers.push(name);
            }
            None => keys.push(token),
        }
    }
    let [key] = keys.as_slice() else {
        return Err("A shortcut needs exactly one non-modifier key".into());
    };
    if modifiers.len() < 2 {
        return Err(
            "Use at least two modifier keys (for example Ctrl+Alt) to avoid conflicts".into(),
        );
    }
    let is_character = key.chars().count() == 1
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric());
    if is_character
        && modifiers.len() == 2
        && modifiers.contains(&"ctrl")
        && modifiers.contains(&"shift")
    {
        return Err("Ctrl+Shift+letter shortcuts collide with browsers and editors; choose another combination".into());
    }
    if RESERVED.iter().any(|(reserved_modifiers, reserved_key)| {
        *reserved_key == key.as_str()
            && reserved_modifiers.len() <= modifiers.len()
            && reserved_modifiers
                .iter()
                .all(|name| modifiers.contains(name))
    }) {
        return Err("That shortcut is reserved by Windows".into());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_distinctive_chords() {
        for accelerator in [
            "Ctrl+Alt+F9",
            "ctrl + alt + k",
            "CommandOrControl+Alt+F10",
            "Alt+Shift+F8",
            "Ctrl+Shift+F12",
        ] {
            assert!(validate_accelerator(accelerator).is_ok(), "{accelerator}");
        }
    }

    #[test]
    fn rejects_conflict_prone_or_malformed_chords() {
        for accelerator in [
            "",
            "F9",
            "Ctrl+C",
            "Alt+F4",
            "Ctrl+Alt+Delete",
            "Ctrl+Shift+Escape",
            "Ctrl+Shift+P",
            "Ctrl+Ctrl+K",
            "Ctrl+Alt",
            "Ctrl+Alt+K+L",
            "Ctrl++K",
        ] {
            assert!(validate_accelerator(accelerator).is_err(), "{accelerator}");
        }
    }
}
