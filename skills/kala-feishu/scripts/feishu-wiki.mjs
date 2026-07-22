/**
 * feishu-wiki.mjs —— 飞书知识库(Wiki)运维(用户身份 user_access_token)。
 *
 * 关键概念:知识库节点(node_token)只是「挂载点」,真正的文档内容实体是它挂的
 * docx 对象(obj_token)。编辑内容要先把 node_token 解析成 obj_token,再交给
 * feishu-doc-writer.mjs / write-md-to-feishu.mjs。wiki 文档 URL 里(.../wiki/XXX)
 * 的 XXX 是 node_token,不是 docx token。
 *
 * 用法:
 *   node feishu-wiki.mjs spaces                                          # 列知识库空间
 *   node feishu-wiki.mjs nodes <space_id> [parent_node_token]            # 列节点(省略父=一级节点)
 *   node feishu-wiki.mjs create <space_id> <title> [parent_node_token] [obj_type]  # 建节点(默认 docx)
 *   node feishu-wiki.mjs resolve <wiki_url_or_node_token>                # 解析出 obj_token/obj_type
 *   node feishu-wiki.mjs rename <space_id> <node_token> <new_title>      # 重命名节点
 *   node feishu-wiki.mjs move <space_id> <node_token> [parent_node_token] [target_space_id]  # 移动节点
 *   node feishu-wiki.mjs movein <space_id> <obj_type> <obj_token> [parent_node_token]  # 把云盘文档移入知识库
 *   node feishu-wiki.mjs delete <wiki_url_or_node_token>                 # 删除节点(删底层对象,进回收站)
 *
 * ⚠️ delete 前必须由 agent 向用户列清单并取得确认(见 SKILL.md)。
 * ⚠️ 空间成员/管理员这类「空间级权限」需在飞书客户端/后台设置,本脚本不代做。
 */
import { api, printResult, fail } from './feishu-api.mjs';
import { autoSelectAccount } from './feishu-route.mjs';

/** 从 wiki URL 或原始 token 里取出 node_token。 */
export function parseWikiToken(input) {
  if (!input) return input;
  const m = input.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  // 去掉可能的 query/hash,返回裸 token
  return input.split(/[?#]/)[0].trim();
}

/** 解析节点 → { node_token, obj_token, obj_type, title, space_id }。 */
export async function getNode(nodeToken) {
  const d = await api('GET', '/wiki/v2/spaces/get_node', { query: { token: nodeToken } });
  return d.node;
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'spaces': {
      const d = await api('GET', '/wiki/v2/spaces', { query: { page_size: '50' } });
      return printResult({ spaces: (d.items || []).map(s => ({ space_id: s.space_id, name: s.name, type: s.space_type })) });
    }
    case 'nodes': {
      const [spaceId, parent] = args;
      if (!spaceId) return fail('用法: nodes <space_id> [parent_node_token]');
      const query = { page_size: '50' };
      if (parent) query.parent_node_token = parent;
      const d = await api('GET', `/wiki/v2/spaces/${spaceId}/nodes`, { query });
      return printResult({
        nodes: (d.items || []).map(n => ({
          title: n.title, node_token: n.node_token, obj_token: n.obj_token,
          obj_type: n.obj_type, has_child: n.has_child,
        })),
        has_more: d.has_more,
      });
    }
    case 'create': {
      const [spaceId, title, parent, objType = 'docx'] = args;
      if (!spaceId || !title) return fail('用法: create <space_id> <title> [parent_node_token] [obj_type=docx]');
      const body = { obj_type: objType, node_type: 'origin', title };
      if (parent) body.parent_node_token = parent;
      const d = await api('POST', `/wiki/v2/spaces/${spaceId}/nodes`, { body });
      // 返回 node_token(挂载点)与 obj_token(内容实体,拿去写入)
      return printResult(d.node);
    }
    case 'resolve': {
      const nodeToken = parseWikiToken(args[0]);
      if (!nodeToken) return fail('用法: resolve <wiki_url_or_node_token>');
      await autoSelectAccount({ url: args[0], wikiToken: nodeToken });
      const node = await getNode(nodeToken);
      return printResult({
        node_token: node.node_token, obj_token: node.obj_token,
        obj_type: node.obj_type, title: node.title, space_id: node.space_id,
      });
    }
    case 'rename': {
      const [spaceId, nodeToken, ...rest] = args;
      const title = rest.join(' ');
      if (!spaceId || !nodeToken || !title) return fail('用法: rename <space_id> <node_token> <new_title>');
      const d = await api('POST', `/wiki/v2/spaces/${spaceId}/nodes/${nodeToken}/update_title`, { body: { title } });
      return printResult(d ?? { renamed: nodeToken, title });
    }
    case 'move': {
      const [spaceId, nodeToken, parent, targetSpaceId] = args;
      if (!spaceId || !nodeToken) return fail('用法: move <space_id> <node_token> [parent_node_token] [target_space_id]');
      const body = {};
      if (parent) body.target_parent_token = parent;
      if (targetSpaceId) body.target_space_id = targetSpaceId;
      const d = await api('POST', `/wiki/v2/spaces/${spaceId}/nodes/${nodeToken}/move`, { body });
      return printResult(d);
    }
    case 'movein': {
      const [spaceId, objType, objToken, parent] = args;
      if (!spaceId || !objType || !objToken) return fail('用法: movein <space_id> <obj_type> <obj_token> [parent_node_token]');
      const body = { obj_type: objType, obj_token: objToken };
      if (parent) body.parent_wiki_token = parent;
      const d = await api('POST', `/wiki/v2/spaces/${spaceId}/nodes/move_docs_to_wiki`, { body });
      return printResult(d);
    }
    case 'delete': {
      const nodeToken = parseWikiToken(args[0]);
      if (!nodeToken) return fail('用法: delete <wiki_url_or_node_token>');
      await autoSelectAccount({ url: args[0], wikiToken: nodeToken });
      // 解析出底层对象,删对象(进回收站,可恢复)。节点随之从知识库树移除。
      const node = await getNode(nodeToken);
      if (!node?.obj_token) return fail(`无法解析节点的 obj_token: ${nodeToken}`);
      const d = await api('DELETE', `/drive/v1/files/${node.obj_token}`, { query: { type: node.obj_type } });
      return printResult({ deleted_node: nodeToken, obj_token: node.obj_token, obj_type: node.obj_type, result: d });
    }
    default:
      console.log('用法: node feishu-wiki.mjs <spaces|nodes|create|resolve|rename|move|movein|delete> ...');
      process.exit(1);
  }
}

// 仅在作为脚本直接运行时执行 CLI(被 import 时不跑)
const isMain = process.argv[1] && /feishu-wiki\.mjs$/.test(process.argv[1]);
if (isMain) main().catch(fail);
