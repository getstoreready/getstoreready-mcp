import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { editorUrl, gsr } from './client.js';
import { text } from './response.js';

// Store connection + project language management — everything the project
// settings page does. Secrets (the .p8 key, the service-account JSON) are
// read from a local file path by this process and sent straight to GSR, so
// they never have to be pasted into the conversation.

const store = z.enum(['app_store', 'google_play']);
const base = (s: z.infer<typeof store>) => (s === 'app_store' ? 'app-store' : 'google-play');

async function readSecretFile(path: string): Promise<string> {
  const full = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  const content = (await readFile(full, 'utf8')).trim();
  if (!content) throw new Error(`${full} is empty.`);
  return content;
}

export function registerStoreSetupTools(server: McpServer): void {
  server.tool(
    'list_store_credentials',
    'List the saved App Store Connect API keys or Google Play service accounts on this account ' +
      '(labels and ids only — never the secret). Requires Premium/Pro.',
    { store },
    async ({ store: s }) => text(await gsr.get(`/${base(s)}/credentials`)),
  );

  server.tool(
    'add_app_store_credential',
    'Save an App Store Connect API key (Users and Access → Integrations → App Store Connect API). ' +
      'Pass the PATH of the downloaded AuthKey_XXXX.p8 file — it is read locally and sent ' +
      'encrypted to GetStoreReady; do not paste the key into the chat. Requires Premium/Pro.',
    {
      label: z.string().min(1).max(80).describe('Your name for this key, e.g. "Acme ASC"'),
      issuerId: z.string().uuid().describe('Issuer ID shown above the keys list'),
      keyId: z.string().min(8).max(20).describe('Key ID, e.g. 2X9R4HXF34'),
      privateKeyPath: z
        .string()
        .min(1)
        .describe('Path to the .p8 file, e.g. ~/Downloads/AuthKey_2X9R4HXF34.p8'),
    },
    async ({ label, issuerId, keyId, privateKeyPath }) => {
      const privateKey = await readSecretFile(privateKeyPath);
      if (!privateKey.includes('PRIVATE KEY'))
        throw new Error('That file is not a .p8 private key.');
      const res = await gsr.post('/app-store/credentials', { label, issuerId, keyId, privateKey });
      return text({ ...(res as object), next: 'test_store_credential, then link_app_store' });
    },
  );

  server.tool(
    'add_google_play_credential',
    'Save a Google Play service account (its JSON key, with the account invited in Play Console → ' +
      'Users and permissions). Pass the PATH of the JSON key file — it is read locally and sent ' +
      'encrypted to GetStoreReady; do not paste it into the chat. Requires Premium/Pro.',
    {
      label: z.string().min(1).max(80),
      serviceAccountJsonPath: z.string().min(1).describe('Path to the service-account .json key'),
    },
    async ({ label, serviceAccountJsonPath }) => {
      const serviceAccountJson = await readSecretFile(serviceAccountJsonPath);
      try {
        const parsed = JSON.parse(serviceAccountJson) as { type?: string };
        if (parsed.type !== 'service_account') throw new Error();
      } catch {
        throw new Error('That file is not a Google service-account JSON key.');
      }
      const res = await gsr.post('/google-play/credentials', { label, serviceAccountJson });
      return text({ ...(res as object), next: 'test_store_credential, then link_google_play' });
    },
  );

  server.tool(
    'test_store_credential',
    'Check a saved credential works. App Store: optionally pass ascAppId + bundleId to also check ' +
      'it can see that app. Google Play: optionally pass packageName.',
    {
      store,
      credentialId: z.string().min(1),
      ascAppId: z.string().regex(/^\d+$/).optional(),
      bundleId: z.string().optional(),
      packageName: z.string().optional(),
    },
    async ({ store: s, credentialId, ascAppId, bundleId, packageName }) =>
      text(
        await gsr.post(
          `/${base(s)}/credentials/${credentialId}/test`,
          s === 'app_store' ? { ascAppId, bundleId } : { packageName },
        ),
      ),
  );

  server.tool(
    'delete_store_credential',
    'Remove a saved credential from GetStoreReady (the key itself stays in Apple / Google). ' +
      'Projects linked with it must be unlinked first. Ask the user before calling.',
    { store, credentialId: z.string().min(1) },
    async ({ store: s, credentialId }) => {
      await gsr.delete(`/${base(s)}/credentials/${credentialId}`);
      return text({ deleted: credentialId });
    },
  );

  server.tool(
    'link_app_store',
    'Connect a project to an App Store Connect app so it can be previewed and pushed. ascAppId is ' +
      'the numeric Apple ID (App Information page), bundleId must match the app.',
    {
      projectId: z.string().min(1),
      credentialId: z
        .string()
        .min(1)
        .describe('From list_store_credentials / add_app_store_credential'),
      ascAppId: z.string().regex(/^\d+$/),
      bundleId: z.string().min(3),
    },
    async ({ projectId, ...body }) => {
      const res = await gsr.put(`/projects/${projectId}/app-store/link`, body);
      return text({ ...(res as object), editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'link_google_play',
    'Connect a project to a Google Play app (by package name) so it can be previewed and pushed.',
    {
      projectId: z.string().min(1),
      credentialId: z
        .string()
        .min(1)
        .describe('From list_store_credentials / add_google_play_credential'),
      packageName: z.string().min(3).describe('e.g. com.acme.app'),
    },
    async ({ projectId, ...body }) => {
      const res = await gsr.put(`/projects/${projectId}/google-play/link`, body);
      return text({ ...(res as object), editorUrl: editorUrl(projectId) });
    },
  );

  server.tool(
    'unlink_store',
    'Disconnect a project from its App Store or Google Play app. Nothing changes in the store; ' +
      'the credential stays saved. Ask the user before calling.',
    { projectId: z.string().min(1), store },
    async ({ projectId, store: s }) => {
      await gsr.delete(`/projects/${projectId}/${base(s)}/link`);
      return text({ unlinked: s });
    },
  );

  server.tool(
    'test_store_link',
    'Check a project’s store link: the credential works and can reach the linked app.',
    { projectId: z.string().min(1), store },
    async ({ projectId, store: s }) =>
      text(await gsr.post(`/projects/${projectId}/${base(s)}/test`, {})),
  );

  server.tool(
    'remove_store_language',
    'Remove a store language from a project (its listing text and translated screen text for that ' +
      'language go with it). The primary language cannot be removed — make another one primary ' +
      'first. Ask the user before calling.',
    { projectId: z.string().min(1), languageCode: z.string().min(2).describe('e.g. de_DE') },
    async ({ projectId, languageCode }) => {
      await gsr.delete(
        `/projects/${projectId}/store-languages/${encodeURIComponent(languageCode)}`,
      );
      return text({
        removed: languageCode,
        ...(await gsr.get<object>(`/projects/${projectId}/store-languages`)),
      });
    },
  );

  server.tool(
    'reorder_store_languages',
    'Set the order of a project’s store languages. Pass every project language exactly once.',
    { projectId: z.string().min(1), languageCodes: z.array(z.string().min(2)).min(1).max(60) },
    async ({ projectId, languageCodes }) => {
      await gsr.put(`/projects/${projectId}/store-languages/reorder`, { languageCodes });
      return text(await gsr.get(`/projects/${projectId}/store-languages`));
    },
  );

  server.tool(
    'set_primary_store_language',
    'Make one of the project’s store languages the primary (default) one — the source language ' +
      'for translation and the fallback for untranslated text.',
    { projectId: z.string().min(1), languageCode: z.string().min(2) },
    async ({ projectId, languageCode }) => {
      await gsr.patch(`/projects/${projectId}`, { defaultStoreLanguage: languageCode });
      return text(await gsr.get(`/projects/${projectId}/store-languages`));
    },
  );
}
