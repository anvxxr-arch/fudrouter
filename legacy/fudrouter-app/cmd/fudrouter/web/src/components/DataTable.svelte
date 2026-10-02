<script>
  let { columns = [], data = [], empty = 'No data' } = $props()
</script>

<div class="card">
  {#if data.length > 0}
    <table class="table">
      <thead>
        <tr>
          {#each columns as col}
            <th>{col}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each data as row}
          <tr>
            {#each col, i}
              <td>{row[col.prop] ?? ''}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="muted" style="text-align:center; padding: 2rem">{empty}</p>
  {/if}
</div>

<style>
  .card {
    background: #16213e;
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 10px;
    padding: 1.2rem;
  }
  
  .table { width: 100%; border-collapse: collapse; }
  
  .table th {
    text-align: left;
    padding: 0.6rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #8888aa;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  
  .table td {
    padding: 0.6rem;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    font-size: 0.85rem;
  }
  
  .muted { color: #8888aa; font-size: 0.85rem; }
</style>
