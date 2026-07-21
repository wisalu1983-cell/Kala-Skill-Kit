/**
 * feishu-drive.mjs —— 飞书云盘运维(用户身份 user_access_token)。
 *
 * 用法:
 *   node feishu-drive.mjs root                                  # 取根目录 folder_token
 *   node feishu-drive.mjs list [folder_token]                   # 列目录(省略=根目录)
 *   node feishu-drive.mjs mkdir <name> [parent_folder_token]    # 建文件夹
 *   node feishu-drive.mjs upload <local_file> <folder_token>    # 上传文件
 *   node feishu-drive.mjs move <token> <folder_token> [type]    # 移动(type 默认 docx)
 *   node feishu-drive.mjs delete <token> <type>                 # 删除(进回收站,可恢复)
 *   node feishu-drive.mjs public <token> [type]                 # 设为「任何人可读」(用 tenant token)
 *
 * ⚠️ delete 前必须由 agent 向用户列清单并取得确认(见 SKILL.md)。
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { api, uploadMultipart, printResult, fail } from './feishu-api.mjs';

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'root': {
      const d = await api('GET', '/drive/explorer/v2/root_folder/meta');
      return printResult(d);
    }
    case 'list': {
      const folderToken = args[0];
      const query = { page_size: '50' };
      if (folderToken) query.folder_token = folderToken;
      const d = await api('GET', '/drive/v1/files', { query });
      return printResult({ files: (d.files || []).map(f => ({ name: f.name, token: f.token, type: f.type })), has_more: d.has_more });
    }
    case 'mkdir': {
      const [name, parent] = args;
      if (!name) return fail('用法: mkdir <name> [parent_folder_token]');
      // create_folder 必须带父 folder_token;不传父时默认建在根目录(先取 root token)
      let folderToken = parent;
      if (!folderToken) {
        const root = await api('GET', '/drive/explorer/v2/root_folder/meta');
        folderToken = root.token;
      }
      const d = await api('POST', '/drive/v1/files/create_folder', { body: { name, folder_token: folderToken } });
      return printResult(d);
    }
    case 'upload': {
      const [file, folderToken] = args;
      if (!file || !folderToken) return fail('用法: upload <local_file> <folder_token>');
      const buf = readFileSync(file);
      const fileName = basename(file);
      const d = await uploadMultipart('/drive/v1/files/upload_all', [
        ['file_name', fileName],
        ['parent_type', 'explorer'],
        ['parent_node', folderToken],
        ['size', String(buf.length)],
        ['file', buf, { filename: fileName, contentType: 'application/octet-stream' }],
      ]);
      return printResult(d);
    }
    case 'move': {
      const [token, folderToken, type = 'docx'] = args;
      if (!token || !folderToken) return fail('用法: move <token> <folder_token> [type=docx]');
      const d = await api('POST', `/drive/v1/files/${token}/move`, { body: { type, folder_token: folderToken } });
      return printResult(d);
    }
    case 'delete': {
      const [token, type] = args;
      if (!token || !type) return fail('用法: delete <token> <type>  (type: file|docx|folder|...)');
      const d = await api('DELETE', `/drive/v1/files/${token}`, { query: { type } });
      return printResult({ deleted: token, type, result: d });
    }
    case 'public': {
      const [token, type = 'docx'] = args;
      if (!token) return fail('用法: public <token> [type=docx]');
      // 文档归用户所有 → 用 user token(owner 身份)设公开权限。
      // 若报 1063002/权限拒绝,多半是组织管理员整体禁用了外链分享(环境策略,非脚本问题)。
      const d = await api('PATCH', `/drive/v1/permissions/${token}/public`, {
        query: { type },
        body: { external_access_entity: 'open', security_entity: 'anyone_can_view', link_share_entity: 'anyone_readable' },
      });
      return printResult(d);
    }
    default:
      console.log('用法: node feishu-drive.mjs <root|list|mkdir|upload|move|delete|public> ...');
      process.exit(1);
  }
}

main().catch(fail);
