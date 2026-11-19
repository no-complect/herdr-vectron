# Herdr Vectron

Vectron is a layout for Herdr with dark, boxed panels, a bright vector palette, and three-stage flashes on interaction. The Context panel follows the selected local Codex, Claude Code, Grok Build, or Antigravity CLI session.

![Vectron in stock Herdr with a sample workspace](layouts/vectron.png)

## Install

Give your agent this instruction in Herdr.

> Read ~/.config/herdr-app/AGENTS.md, then add the layout from https://github.com/no-complect/herdr-vectron using RECIPE.md.

For a manual install, copy the files from [layouts](layouts), [mods](mods), and [themes](themes) into their matching directories under ~/.config/herdr-app. Keep the existing files when names collide. Merge the two sections in [keys.json](keys.json) into your own keys.json. Then select **Vectron** in Herdr or run this command.

    herdr-app do layout.switch '{"name":"vectron"}'

Tested with stock Herdr 0.1.16 on macOS. The Context panel requires Python 3 and reads local agent session files. Its reported counts and estimates are labeled separately. Files and Changes run filesystem and Git commands in the selected workspace. The optional browser tools use Herdr Browser if installed. The usage panel reads supported login files and contacts the matching Claude, ChatGPT, or Copilot usage service when a corresponding agent is visible. The Mods screen and Git graph can query GitHub.

## Controls

| Control | Action |
| --- | --- |
| ⌘P | Find a tab, space, or agent |
| ⌘⇧P | Search commands |
| ⌘1–9 and Ctrl+1–9 | Select a space or agent |
| Files, Changes, Context | Select the right-hand panel from the tab bar |
| Context → Expand | Open the larger inspector |

The pane header flashes when a terminal gains focus or its selected agent starts working. The Context panel pulses when its captured counts update.

## Credits

Vectron adapts the [Tuuxic layout](https://github.com/Tuuxic/herdr-tuuxic) and [Whistle](https://github.com/Tuuxic/herdr-whistle). It includes [Herdr Context Facey](https://github.com/no-complect/herdr-context-facey), code from [Herdr](https://github.com/herdrdev/herdr-app), and palettes from [Omarchy](https://github.com/omacom/omarchy). See [LICENSES](LICENSES) and the notices in the bundled mod folders.
