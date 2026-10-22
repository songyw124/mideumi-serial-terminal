//! Native terminal menus and macOS Edit-menu cleanup.

use std::{cell::RefCell, collections::HashMap};

use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, sel, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuDelegate, NSMenuItem};
use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol, NSString};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

// Keep the original items so state updates and menu events share one definition.
struct MenuActions(HashMap<&'static str, MenuItem<tauri::Wry>>);

thread_local! {
    // AppKit holds its delegate weakly. Retain ours on the main thread for the
    // application's lifetime, without leaking it or sharing AppKit across threads.
    static EDIT_DELEGATE: RefCell<Option<Retained<EditMenuDelegate>>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "MideumiEditMenuDelegate"]
    #[thread_kind = MainThreadOnly]
    struct EditMenuDelegate;

    unsafe impl NSObjectProtocol for EditMenuDelegate {}

    unsafe impl NSMenuDelegate for EditMenuDelegate {
        #[unsafe(method(menuNeedsUpdate:))]
        fn menu_needs_update(&self, menu: &NSMenu) {
            retain_edit_commands(menu);
        }

        #[unsafe(method(menuWillOpen:))]
        fn menu_will_open(&self, menu: &NSMenu) {
            // AppKit can insert system features after startup or when focus
            // changes, so clean the menu again immediately before display.
            retain_edit_commands(menu);
        }
    }
);

fn is_edit_command(action: Option<objc2::runtime::Sel>) -> bool {
    action.is_some_and(|action| {
        [
            sel!(undo:),
            sel!(redo:),
            sel!(cut:),
            sel!(copy:),
            sel!(paste:),
            sel!(selectAll:),
        ]
        .contains(&action)
    })
}

fn retain_edit_commands(menu: &NSMenu) {
    for item in menu.itemArray().iter() {
        if !item.isSeparatorItem() && !is_edit_command(item.action()) {
            menu.removeItem(&item);
        }
    }
    // Removing system-added sections should not leave empty separators behind.
    let mut previous_separator = true;
    for item in menu.itemArray().iter() {
        let separator = item.isSeparatorItem();
        if separator && previous_separator {
            menu.removeItem(&item);
        } else {
            previous_separator = separator;
        }
    }
    if let Some(last) = menu.itemArray().lastObject() {
        if last.isSeparatorItem() {
            menu.removeItem(&last);
        }
    }
}

pub fn install() -> Result<(), Box<dyn std::error::Error>> {
    let main_menu = native_menu()?;
    let mtm = MainThreadMarker::from(&*main_menu);
    // Identify the Edit menu by its action, rather than a localized title.
    let menu = main_menu
        .itemArray()
        .iter()
        .filter_map(|item| item.submenu())
        .find(|menu| {
            menu.itemArray()
                .iter()
                .any(|item| item.action() == Some(sel!(selectAll:)))
        })
        .ok_or("The native Edit menu is missing")?;

    // Available on newer macOS versions only. Keep older macOS versions safe.
    if menu.respondsToSelector(sel!(setAutomaticallyInsertsWritingToolsItems:)) {
        menu.setAutomaticallyInsertsWritingToolsItems(false);
    }
    retain_edit_commands(&menu);
    // SAFETY: Main-thread allocation of the declared NSObject subclass; init
    // takes no arguments and returns an owned initialized delegate.
    let delegate: Retained<EditMenuDelegate> =
        unsafe { msg_send![mtm.alloc::<EditMenuDelegate>(), init] };
    menu.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    EDIT_DELEGATE.with(|slot| *slot.borrow_mut() = Some(delegate));
    Ok(())
}

/// Preserve the system editing/window commands and add terminal actions.
pub fn configure(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let items = [
        ("connect", "terminal-connect", "Connect", Some("Cmd+O")),
        (
            "disconnect",
            "terminal-disconnect",
            "Disconnect",
            Some("Cmd+D"),
        ),
        ("save", "terminal-save", "Save Log…", Some("Cmd+S")),
        ("find", "terminal-find", "Find…", Some("Cmd+F")),
        ("clear", "terminal-clear", "Clear Log", Some("Cmd+L")),
        ("refresh", "terminal-refresh", "Refresh Devices", None),
        (
            "zoomIn",
            "terminal-zoom-in",
            "Increase Font Size",
            Some("Cmd+="),
        ),
        (
            "zoomOut",
            "terminal-zoom-out",
            "Decrease Font Size",
            Some("Cmd+-"),
        ),
        (
            "zoomReset",
            "terminal-zoom-reset",
            "Reset Font Size",
            Some("Cmd+0"),
        ),
    ]
    .into_iter()
    .map(|(action, id, text, shortcut)| {
        // Enable actions only after the frontend listener is ready.
        MenuItem::with_id(app, id, text, false, shortcut).map(|item| (action, item))
    })
    .collect::<tauri::Result<HashMap<_, _>>>()?;

    let menu = Menu::default(app.handle())?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            match submenu.text()?.as_str() {
                "File" => {
                    while submenu.remove_at(0)?.is_some() {}
                    submenu.append_items(&[
                        &items["connect"],
                        &items["disconnect"],
                        &PredefinedMenuItem::separator(app)?,
                        &items["save"],
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::close_window(app, None)?,
                    ])?;
                }
                "View" => submenu.insert_items(
                    &[
                        &items["zoomIn"],
                        &items["zoomOut"],
                        &items["zoomReset"],
                        &PredefinedMenuItem::separator(app)?,
                    ],
                    0,
                )?,
                "Help" if submenu.items()?.is_empty() => menu.remove(&item)?,
                _ => {}
            }
        }
    }
    menu.insert(
        &Submenu::with_items(
            app,
            "Terminal",
            true,
            &[
                &items["find"],
                &items["clear"],
                &PredefinedMenuItem::separator(app)?,
                &items["refresh"],
            ],
        )?,
        3,
    )?;
    app.set_menu(menu)?;
    // Tauri's physical accelerator parser does not accept a literal plus.
    // Command+Equals remains a webview alias for Command+Plus.
    let native = native_menu()?;
    find_native_item(&native, &items["zoomIn"].text()?)
        .ok_or("The Increase Font Size menu item is missing")?
        .setKeyEquivalent(&NSString::from_str("+"));
    app.manage(MenuActions(items));
    app.on_menu_event(|app, event| {
        let items = app.state::<MenuActions>();
        if let Some((&action, _)) = items.0.iter().find(|(_, item)| item.id() == event.id()) {
            if let Err(error) = app.emit_to("main", "terminal-action", action) {
                eprintln!("Could not dispatch terminal menu action: {error}");
            }
        }
    });
    install()
}

pub fn set_state(
    app: &tauri::AppHandle,
    connected: bool,
    busy: bool,
    saving: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    for (&action, item) in &app.state::<MenuActions>().0 {
        let enabled = match action {
            "connect" | "refresh" => !connected && !busy,
            "disconnect" => connected && !busy,
            "save" => !saving,
            _ => true,
        };
        item.set_enabled(enabled)?;
    }
    Ok(())
}

fn native_menu() -> Result<Retained<NSMenu>, Box<dyn std::error::Error>> {
    let mtm = MainThreadMarker::new().ok_or("Menu access must run on the main thread")?;
    NSApplication::sharedApplication(mtm)
        .mainMenu()
        .ok_or_else(|| "The native app menu is missing".into())
}

fn find_native_item(menu: &NSMenu, text: &str) -> Option<Retained<NSMenuItem>> {
    for item in menu.itemArray().iter() {
        if item.title().to_string() == text {
            return Some(item);
        }
        if let Some(submenu) = item.submenu() {
            if let Some(found) = find_native_item(&submenu, text) {
                return Some(found);
            }
        }
    }
    None
}

/// Activate with AppKit's menu-bar feedback; disabled items consume the shortcut.
pub fn activate(app: &tauri::AppHandle, action: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let items = app.state::<MenuActions>();
    let item = items.0.get(action).ok_or("Unknown menu action")?;
    let menu = native_menu()?;
    let native_item =
        find_native_item(&menu, &item.text()?).ok_or("The native menu item is missing")?;
    if native_item.isEnabled() {
        // SAFETY: menu retains the parent hierarchy throughout this main-thread call.
        let parent = unsafe { native_item.menu() }.ok_or("The native submenu is missing")?;
        parent.performActionForItemAtIndex(parent.indexOfItem(&native_item));
    }
    Ok(true)
}
