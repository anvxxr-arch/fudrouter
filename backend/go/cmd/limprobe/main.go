package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/store"
)

func main() {
	ctx := context.Background()
	st, err := store.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	key, err := st.LookupAPIKey(ctx, os.Args[1])
	if err != nil {
		panic(err)
	}
	fmt.Printf("key=%s user=%q policy=%+v\n", key.ID, key.UserID, key.Policy)
	lim, err := st.EffectiveLimits(ctx, key)
	if err != nil {
		panic(err)
	}
	b, _ := json.MarshalIndent(lim, "", "  ")
	fmt.Println(string(b))
}
