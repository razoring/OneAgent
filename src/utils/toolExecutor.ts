import { injectSetOfMark, clearSetOfMark, interactWithElement, executeBrowserNavigation, getSemanticDOM } from './browserTools';

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
      case 'search_web':
        const searchRes = await electronAPI.searchWeb(args.query, args.limit);
        resStr = JSON.stringify(searchRes);
        break;
      case 'view_file':
        const viewRes = await electronAPI.viewFile(args.AbsolutePath);
        resStr = JSON.stringify(viewRes);
        break;
      case 'list_dir':
        const listRes = await electronAPI.listDir(args.DirectoryPath);
        resStr = JSON.stringify(listRes);
        break;
      case 'write_to_file':
        const writeRes = await electronAPI.writeToFile(args);
        resStr = JSON.stringify(writeRes);
        break;
      case 'replace_file_content':
        const repRes = await electronAPI.replaceFileContent(args);
        resStr = JSON.stringify(repRes);
        break;
      case 'delete_file':
        const delRes = await electronAPI.deleteFile(args.filePath);
        resStr = JSON.stringify(delRes);
        break;
      case 'run_command':
        const runRes = await electronAPI.runCommand(args.command, args.cwd);
        resStr = JSON.stringify(runRes);
        break;
      
      // Browser Tools
      case 'browser_navigate':
        executeBrowserNavigation('navigate', args.url);
        resStr = "Navigation started to " + args.url;
        break;
      case 'browser_go_back':
        executeBrowserNavigation('back');
        resStr = "Navigated back";
        break;
      case 'browser_get_dom':
        resStr = await getSemanticDOM();
        break;
      case 'browser_visual_capture':
        const markers = await injectSetOfMark();
        resStr = "Set-of-Mark injected. Elements available:\n" + JSON.stringify(markers, null, 2);
        break;
      case 'browser_interact':
        const success = await interactWithElement(args.id, args.action, args.value);
        resStr = success ? "Interaction successful" : "Interaction failed or element not found";
        break;
      
      // Desktop Tools
      case 'desktop_screenshot':
        const screenRes = await electronAPI.takeScreenshot();
        resStr = JSON.stringify(screenRes);
        break;
      case 'desktop_click':
        const clickRes = await electronAPI.desktopClick(args.x, args.y);
        resStr = JSON.stringify(clickRes);
        break;
      case 'desktop_type':
        const typeRes = await electronAPI.desktopType(args.text);
        resStr = JSON.stringify(typeRes);
        break;
        
      default:
        resStr = "Unknown tool: " + toolName;
    }
  } catch (e: any) {
    resStr = "Execution error: " + e.message;
  }

  return { toolName, result: resStr };
};
