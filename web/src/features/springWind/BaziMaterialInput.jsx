import React, { useRef } from 'react';

const statusText = state => ({
  importing: `正在读取 ${state.fileName || '素材'}…`,
  recognizing: `正在识别 ${state.fileName || '图片'}…`,
  editable_result: '识别结果已回填，可继续修改',
  error: state.error,
  text: '文字模式 · 内容会自动保存到当前账户',
  idle: '直接键入，或拖入 TXT、JPG、PNG、WebP',
}[state.mode] || '');

export default function BaziMaterialInput({ state, dispatch, onMaterial, onBlur, localVision, preview }) {
  const materialRef = useRef(null);
  const cameraRef = useRef(null);
  const choose = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onMaterial(file);
  };
  const drop = event => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) onMaterial(file);
  };
  return (
    <div
      className={`bazi-material-input mode-${state.mode}`}
      data-testid="bazi-material-input"
      onDragOver={event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={drop}
    >
      <textarea
        id="spring-bazi"
        rows="4"
        maxLength="500"
        value={state.text}
        onChange={event => dispatch({ type: 'typed', value: event.target.value })}
        onBlur={onBlur}
        placeholder="甲子年 丙寅月 壬午日 辛亥时；也可以把八字截图直接拖进这里"
        aria-describedby="spring-bazi-status"
        required
      />
      {preview && <img className="bazi-input-preview" src={preview} alt="正在识别的八字素材"/>}
      <div className="bazi-input-tools">
        <span id="spring-bazi-status" role={state.mode === 'error' ? 'alert' : 'status'}>{statusText(state)}</span>
        <div>
          <button type="button" onClick={() => materialRef.current?.click()}>选择素材</button>
          <button type="button" onClick={() => cameraRef.current?.click()}>选择图片 / 拍照</button>
        </div>
      </div>
      <input ref={materialRef} hidden type="file" accept=".txt,.text,text/plain,image/jpeg,image/png,image/webp" onChange={choose}/>
      <input ref={cameraRef} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={choose}/>
      <small className="bazi-input-privacy">{localVision ? '图片只在这台 Mac 本机识别，不会上传' : '图片最大 5 MB；上传前会清除元数据'}</small>
    </div>
  );
}

