# Installation

Install steps for DeepLore. Install the extension, point it at an Obsidian vault, then either run the setup wizard (`/dle-setup`) or configure manually.

## Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) v1.12.14+
- [Obsidian](https://obsidian.md/) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled
- A vault for your lore. Your existing Obsidian vault works; `/dle-import` converts SillyTavern World Info JSON into vault entries
- For AI search (optional): a saved Connection Manager profile in SillyTavern (any provider). This is the only supported connection path as of v2.5 — the old Custom Proxy mode was removed

> [!IMPORTANT]
> If you previously ran the older standalone `sillytavern-DeepLore` extension, uninstall it first. Running both at once corrupts prompt injection.

---

## Step 1: install the extension

### Option A: built-in installer (recommended)

1. Open SillyTavern
2. Go to the **Extensions** panel (puzzle piece icon)
3. Click **Install Extension**
4. Paste the URL:
   ```
   https://github.com/pixelnull/sillytavern-DeepLore-Enhanced
   ```
5. Click **Install**

### Option B: manual git clone

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/pixelnull/sillytavern-DeepLore-Enhanced.git
```

---

## Step 2: restart SillyTavern

Stop and restart SillyTavern to load the new extension.

---

## First-time setup

> [!TIP]
> Run `/dle-setup` in the SillyTavern chat input to use the guided setup wizard. It walks through vault connection, tags, matching, AI search, the Librarian, vault structure, and lorebook import in one flow. See [[Setup Wizard]].

The rest of this section covers manual setup. Skip it if you ran the wizard.

### Obsidian connection

1. In Obsidian, open **Settings → Community Plugins** and install/enable **Local REST API**
2. Go to **Settings → Local REST API**, note the **API port** (default `27123` for HTTP), and copy the **API key**
3. In SillyTavern, go to **Extensions → DeepLore**
4. Enter the port and API key in the connection fields
5. Click **Test All**. You should see a success message
6. Check **Enable DeepLore**
7. Click **Refresh Index** to pull entries from your vault

> [!NOTE]
> HTTP is recommended. HTTPS requires installing the Local REST API plugin's self-signed certificate to your OS trust store, and DLE does not bundle a setup walkthrough for that. If you need HTTPS, see the [Local REST API author's guide on trusting the certificate](https://github.com/coddingtonbear/obsidian-web/wiki/How-do-I-get-my-browser-trust-my-Obsidian-Local-REST-API-certificate%3F).

Any entries in your vault tagged `lorebook` (or whatever tag you configured) match by keywords during generation. See [[Writing Vault Entries]] for entry format.

### AI search setup (optional)

AI search adds a second pipeline stage: after keyword pre-filtering, an AI model reads compact summaries of the candidates and selects the contextually relevant ones. See [[AI Search]] for the full mechanism.

AI search reuses an existing SillyTavern API connection through a Connection Manager profile. No extra software, and no `config.yaml` changes.

1. Confirm you have at least one API connection set up in SillyTavern and saved as a Connection Manager profile
2. In DLE settings, scroll to **AI Search**
3. Check **Enable AI Search**
4. Set connection mode to **Connection Profile** (the only mode in v2.5)
5. Choose your profile from the dropdown
6. Optionally set a **Model Override** (e.g., to force a cheaper model like Haiku)
7. Click **Test AI Search** to verify

> [!NOTE]
> The legacy **Custom Proxy** connection mode was removed in v2.5. If you ran an older DeepLore that pointed AI search at a local proxy (e.g. claude-code-proxy), DeepLore migrates that setting to **Connection Profile** automatically on first load and shows a one-time notice asking you to pick a profile. Connection Profile is now the only supported path, and DeepLore's AI features no longer require `enableCorsProxy: true`. The same applies to the Scribe, Auto Lorebook, AI Notepad, Librarian, and Optimize Keys channels.

---

## Updating

If you installed via the built-in installer, SillyTavern shows an update notification when a new version is available. Click **Update** in the Extensions panel.

If you installed manually, pull the latest changes:

```bash
cd SillyTavern/public/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced
git pull
```

---

## Troubleshooting

### Connection refused (Obsidian)

- **Is Obsidian open?** The Local REST API plugin only serves requests while Obsidian is running.
- **Is the Local REST API plugin enabled?** Check Obsidian Settings → Community Plugins.
- **Check the port:** Default is `27123` (HTTP); `27124` if you configured HTTPS. The port in DLE settings must match what Local REST API is using.
- **Check the API key:** Copy it fresh from Obsidian Settings → Local REST API. Keys regenerate when the plugin is reinstalled.
- **Firewall:** If SillyTavern and Obsidian run on different machines, open the port on the host firewall.

### AI search test fails

- **Profile missing or broken:** Confirm the selected profile still exists and its underlying API connection works. Test the connection in SillyTavern's main API panel first.
- **No profile selected:** Pick a profile in AI Search settings, or create one in Connection Manager.
- **Timeout:** AI search has a configurable timeout (default 20 seconds). Slow providers — especially local models — may need a longer timeout. See [[Settings Reference]].
- **"Custom Proxy mode was removed in v2.5":** You (or an old setting) still point a channel at proxy mode. Open **Settings → Connection → AI Connections** and pick a Connection Profile for that channel.

### No entries found after Refresh Index

- **Check your tags:** Entries must carry the `lorebook` tag (or whatever you set as the lorebook tag). The tag belongs in the frontmatter `tags` array.
- **Check the vault directory:** DLE scans the entire vault by default. Folder filter in settings restricts it if you want.
- **Check frontmatter format:** `keys` and other fields must be valid YAML. See [[Writing Vault Entries]].

### Extension not appearing in SillyTavern

- **Check the extensions folder:** The extension lives at `SillyTavern/public/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced/` (or `data/default-user/extensions/sillytavern-DeepLore-Enhanced/` if you installed it for a single user) with `manifest.json` at the root.
- **Check SillyTavern version:** DeepLore requires SillyTavern v1.12.14+ (enforced by `minimum_client_version` in the manifest). Older versions refuse to load the extension.
- **Clear browser cache:** Hard-refresh (`Ctrl+Shift+R`) or clear cache and reload.
