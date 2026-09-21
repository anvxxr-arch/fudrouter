<script>
  let { message = '', type = 'info', visible = $bindable(false) } = $props()
  
  export function show(msg, t = 'info') {
    message = msg
    type = t
    visible = true
    setTimeout(() => visible = false, 3000)
  }
  
  const colors = {
    info: '#4a9eff',
    success: '#4ade80',
    error: '#ff6b6b',
    warning: '#fbbf24'
  }
</script>

{#if visible}
<div class="toast" style="border-color: {colors[type]}">
  {message}
</div>

<style>
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.8rem 1.2rem;
    background: #16213e;
    border: 1px solid;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    animation: slideIn 0.3s ease;
    z-index: 1000;
    font-size: 0.85rem;
  }
  
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
{/if}
