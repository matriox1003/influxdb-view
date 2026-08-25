/**
 * electron-builder afterPack 钩子：用 resedit（纯 JS）给 Windows exe 嵌入图标。
 * 不需要 rcedit/winCodeSign，不需要签名证书。
 */
const { readFileSync, existsSync } = require('fs');
const { resolve } = require('path');
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');

/** 把 PNG Buffer 包装成最小 ICO 格式 */
function pngToIcoBuf(pngBuf) {
  const dataSize = pngBuf.length;
  const dataOffset = 6 + 16; // header(6) + 1 entry(16)
  const buf = Buffer.alloc(dataOffset + dataSize);

  // ICO header
  buf.writeUInt16LE(0, 0);      // reserved
  buf.writeUInt16LE(1, 2);      // type: ICO
  buf.writeUInt16LE(1, 4);      // count: 1

  // ICO entry (16 bytes at offset 6)
  buf.writeUInt8(0, 6);         // width (0 = 256)
  buf.writeUInt8(0, 7);         // height (0 = 256)
  buf.writeUInt8(0, 8);         // colors
  buf.writeUInt8(0, 9);         // reserved
  buf.writeUInt16LE(1, 10);     // planes
  buf.writeUInt16LE(32, 12);    // bit count
  buf.writeUInt32LE(dataSize, 14);   // image size
  buf.writeUInt32LE(dataOffset, 18); // image offset

  // PNG data at dataOffset
  pngBuf.copy(buf, dataOffset);
  return buf;
}

module.exports = async function (context) {
  const { appOutDir, packager } = context;
  if (packager.platform.nodeName !== 'win32') return;

  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exePath = resolve(appOutDir, exeName);
  const pngPath = resolve(packager.projectDir, 'assets', 'icon.png');

  if (!existsSync(exePath)) {
    console.log('[set-icon] exe not found, skipping');
    return;
  }
  if (!existsSync(pngPath)) {
    console.log('[set-icon] icon not found, skipping');
    return;
  }

  try {
    const pngBuf = readFileSync(pngPath);
    const icoBuf = pngToIcoBuf(pngBuf);

    // 解析 ICO，构建 replaceIconsForResource 需要的图标数组
    const iconFile = Data.IconFile.from(icoBuf);
    const icons = iconFile.icons.map((w) => ({
      width: w.width,
      height: w.height,
      bitCount: w.bitCount,
      bin: w.data.bin,
      isIcon: () => false,
      isRaw: () => true,
    }));

    // 读 exe，替换图标资源
    const exeBuf = readFileSync(exePath);
    const exe = NtExecutable.from(exeBuf);
    const res = NtExecutableResource.from(exe);

    // replaceIconsForResource(destEntries, iconGroupID, lang, icons)
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,  // 资源条目列表
      1,            // 主图标组 ID
      0,            // 语言：中性
      icons,        // IconItem[] / RawIconItem[]
    );

    // 写回（第二个参数 noGrow=false 允许资源段扩容）
    res.outputResource(exe, false);
    const outBuf = Buffer.from(exe.generate());
    require('fs').writeFileSync(exePath, outBuf);
    console.log('[set-icon] icon embedded');
  } catch (err) {
    console.error('[set-icon] failed:', err.message);
  }
};
