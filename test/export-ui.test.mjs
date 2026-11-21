import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

const exportSource = await readFile(new URL('../tools/WowApiSnapshot/Export.lua', import.meta.url), 'utf8');

test('snapshot window reuses controls and clears old exports on close or failure', () => {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const script = `
    SlashCmdList = {}
    local frames, messages = {}, {}
    function print(message) table.insert(messages, message) end
    function CreateFrame(kind, name, parent, template)
      local frame = { scripts = {}, visible = false }
      local function ignore() end
      frame.TitleText = { SetText = ignore }
      frame.SetSize, frame.SetPoint = ignore, ignore
      frame.SetMultiLine, frame.SetFontObject = ignore, ignore
      frame.SetWidth, frame.SetHeight = ignore, ignore
      frame.SetMaxLetters, frame.SetAutoFocus, frame.SetScrollChild = ignore, ignore, ignore
      function frame:SetScript(event, callback) self.scripts[event] = callback end
      function frame:SetText(text) self.text = text; self.selection = nil end
      function frame:SetFocus() self.focus = true end
      function frame:ClearFocus() self.focus = false end
      function frame:HighlightText() self.selection = self.text end
      function frame:Show() self.visible = true end
      function frame:Hide()
        if not self.visible then return end
        self.visible = false
        if self.scripts.OnHide then self.scripts.OnHide(self) end
      end
      table.insert(frames, frame)
      return frame
    end
    local addon = { request = { result = false } }
    function addon.export(request) return assert(request.result, "bad request") end
    local function loadExport(...)
      ${exportSource}
    end
    loadExport("WowApiSnapshot", addon)
    local open = assert(SlashCmdList.WOWAPISNAPSHOT)
    assert(SLASH_WOWAPISNAPSHOT1 == "/wowapisnapshot")
    open()
    assert(#frames == 0 and #messages == 1, "first failure should not create a window")
    addon.request.result = '{"build":"retail","text":"ä你好"}'
    open()
    local window, _, edit = table.unpack(frames)
    assert(#frames == 3 and window.visible and edit.focus)
    assert(edit.text == addon.request.result and edit.selection == edit.text)
    edit.scripts.OnEscapePressed(edit)
    assert(not window.visible and not edit.focus and edit.text == "", "Escape should clear data and focus")
    addon.request.result = '{"build":"forever"}'
    open()
    assert(#frames == 3 and window.visible and edit.focus and edit.selection == addon.request.result)
    window:Hide()
    assert(not edit.focus and edit.text == "", "window close should clear data and focus")
    open()
    addon.request.result = false
    open()
    assert(#messages == 2 and not window.visible and not edit.focus and edit.text == "",
      "export failure should hide and clear the previous result")
  `;
  try {
    const status = lauxlib.luaL_dostring(state, to_luastring(script));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
  } finally {
    lua.lua_close(state);
  }
});
