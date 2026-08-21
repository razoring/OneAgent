import { injectSetOfMark, interactWithElement, executeBrowserNavigation, getSemanticDOM } from './browserTools';
import { getWebSearchSettings } from './llm';

export const executeToolCall = async (toolCallRaw: string): Promise<{ toolName: string, result: string }> => {
  let toolName = 'unknown_tool';
  let args: any = {};
  
  try {
    const parsed = JSON.parse(toolCallRaw);
    toolName = parsed.name || parsed.toolName;
    args = parsed.arguments || parsed.args || {};
  } catch (e: any) {
    return { toolName, result: "Failed to parse JSON tool call: " + e.message };
  }

  const electronAPI = (window as any).electronAPI;
  let resStr = "";

  try {
    switch (toolName) {
      case 'search_web': {
        const query = args.query || args.Query || '';
        const limit = args.limit || args.Limit || 5;
        const { endpoint, apiKey } = getWebSearchSettings();
        if (!endpoint.trim()) {
          resStr = JSON.stringify({
            success: false,
            error: 'No search API configured. Use the embedded browser instead: call browser_navigate with https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + ' then browser_get_dom to read the results.'
          });
          break;
        }
        const searchRes = await electronAPI.searchWeb({ endpoint, apiKey, query, limit });
        resStr = JSON.stringify(searchRes);
        break;
      }
      case 'view_file': {
        const filePath = args.AbsolutePath || args.filePath || args.path || args.TargetFile || args.targetFile;
        const viewRes = await electronAPI.viewFile(filePath);
        resStr = JSON.stringify(viewRes);
        break;
      }
      case 'list_dir': {
        const dirPath = args.DirectoryPath || args.dirPath || args.path || '.';
        const listRes = await electronAPI.listDir(dirPath);
        resStr = JSON.stringify(listRes);
        break;
      }
      case 'write_to_file': {
        const targetFile = args.TargetFile || args.targetFile || args.filePath || args.path;
        const codeContent = args.CodeContent || args.codeContent || args.content || '';
        const overwrite = args.Overwrite ?? args.overwrite ?? true;
        const writeRes = await electronAPI.writeToFile({ targetFile, codeContent, overwrite });
        resStr = JSON.stringify(writeRes);
        break;
      }
      case 'replace_file_content': {
        const targetFile = args.TargetFile || args.targetFile || args.filePath || args.path;
        const targetContent = args.TargetContent ?? args.targetContent ?? '';
        const replacementContent = args.ReplacementContent ?? args.replacementContent ?? '';
        const repRes = await electronAPI.replaceFileContent({ targetFile, targetContent, replacementContent });
        resStr = JSON.stringify(repRes);
        break;
      }
      case 'delete_file': {
        const filePath = args.filePath || args.FilePath || args.targetFile || args.TargetFile || args.path;
        const delRes = await electronAPI.deleteFile(filePath);
        resStr = JSON.stringify(delRes);
        break;
      }
      case 'run_command': {
        const command = args.command || args.CommandLine || args.cmd || '';
        const cwd = args.cwd || args.Cwd;
        const runRes = await electronAPI.runCommand(command, cwd);
        resStr = JSON.stringify(runRes);
        break;
      }
      
      // Browser Tools
      case 'browser_navigate': {
        let url: string = args.url || args.Url || 'https://html.duckduckgo.com';
        url = url.trim();
        if (!/^https?:\/\//i.test(url)) {
          if (url.includes('.') && !url.includes(' ')) {
            url = 'https://' + url;
          } else {
            url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(url);
          }
        }
        resStr = await executeBrowserNavigation('navigate', url);
        break;
      }
      case 'browser_go_back': {
        await executeBrowserNavigation('back');
        resStr = "Navigated back";
        break;
      }
      case 'browser_get_dom': {
        resStr = await getSemanticDOM();
        break;
      }
      case 'browser_visual_capture': {
        const markers = await injectSetOfMark();
        resStr = "Set-of-Mark injected. Elements available:\n" + JSON.stringify(markers, null, 2);
        break;
      }
      case 'browser_interact': {
        const id = args.id || args.Id || 0;
        const action = args.action || args.Action || 'click';
        const value = args.value || args.Value;
        const success = await interactWithElement(id, action, value);
        resStr = success ? "Interaction successful" : "Interaction failed or element not found";
        break;
      }
      
      // Desktop Tools
      case 'desktop_screenshot': {
        const screenRes = await electronAPI.takeScreenshot();
        resStr = JSON.stringify(screenRes);
        break;
      }
      case 'desktop_click': {
        const x = args.x ?? args.X ?? 0;
        const y = args.y ?? args.Y ?? 0;
        const clickRes = await electronAPI.desktopClick(x, y);
        resStr = JSON.stringify(clickRes);
        break;
      }
      case 'desktop_type': {
        const text = args.text || args.Text || '';
        const typeRes = await electronAPI.desktopType(text);
        resStr = JSON.stringify(typeRes);
        break;
      }
        
      default:
        resStr = "Unknown tool: " + toolName;
    }
  } catch (e: any) {
    resStr = "Execution error: " + e.message;
  }

  return { toolName, result: resStr };
};
