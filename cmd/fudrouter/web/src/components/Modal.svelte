<script>
  let { open = $bindable(false), title = '', children } = $props()
  
  export function close() { open = false }
  export function show() { open = true }
  
  function handleKey(e) {
    if (e.key === 'Escape') close()
  }
</script>

{#if open}
<div class="overlay" onclick={() => close()} onkeydown={handleKey}>
  <div class="modal" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <h3>{title}</h3>
      <button class="close" onclick={() => close()}>×</button>
    </div>
    <div class="modal-body">
      {@render children?.()}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999;
  }
  
  .modal {
    background: #16213e;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 1.5rem;
    min-width: 400px;
    max-width: 600px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  
  .modal-header h3 { margin: 0; font-size: 1.1rem; }
  
  .close {
    background: transparent;
    border: none;
    color: #8888aa;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0.2rem 0.5rem;
  }
  
  .close:hover { color: #e8a87c; }
  
  .modal-body { display: flex; flex-direction: column; gap: 0.8rem; }
</style>
