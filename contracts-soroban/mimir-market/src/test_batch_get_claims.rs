#![cfg(test)]
//! `batch_get_claims` — read multiple claims in a single call.
//!
//! Coverage:
//!   positive     – single id, multiple ids, all present, sparse present/absent
//!   negative     – all-missing ids, batch too large, empty input
//!   boundary     – exactly MAX_BATCH_CLAIMS ids (allowed),
//!                  MAX_BATCH_CLAIMS + 1 (rejected), single id, two ids
//!   positional   – result order matches input order, including duplicates
//!   conservation – no money movement, escrow balance unchanged
//!   state        – resolved, cancelled, and open claims all returned correctly
//!   regression   – single get_claim and batch agree on every field

extern crate std;

use soroban_sdk::testutils::Ledger;
use soroban_sdk::Vec;

use crate::test_common::{Fixture, USDC};
use crate::types::{ClaimState, WinnerSide, MAX_BATCH_CLAIMS};

// ── helpers ───────────────────────────────────────────────────────────────────

/// Create a simple open claim and return its id.
fn open_claim(f: &Fixture) -> u64 {
    let creator = f.user(100 * USDC);
    f.client().create_claim(&creator, &f.params(10 * USDC))
}

/// Build a `Vec<u64>` of claim ids from a slice.
fn ids(f: &Fixture, slice: &[u64]) -> Vec<u64> {
    let mut v: Vec<u64> = Vec::new(&f.env);
    for &id in slice {
        v.push_back(id);
    }
    v
}

// ── positive ─────────────────────────────────────────────────────────────────

#[test]
fn single_existing_id_returns_some() {
    let f = Fixture::new(0, 0);
    let id = open_claim(&f);

    let result = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    assert_eq!(result.len(), 1);
    assert!(result.get(0).unwrap().is_some(), "existing claim should be Some");
}

#[test]
fn multiple_existing_ids_all_return_some() {
    let f = Fixture::new(0, 0);
    let id0 = open_claim(&f);
    let id1 = open_claim(&f);
    let id2 = open_claim(&f);

    let result = f.client().batch_get_claims(&ids(&f, &[id0, id1, id2])).unwrap();
    assert_eq!(result.len(), 3);
    for i in 0..3u32 {
        assert!(result.get(i).unwrap().is_some(), "slot {i} should be Some");
    }
}

#[test]
fn mix_of_existing_and_missing_ids_returns_correct_somes_and_nones() {
    let f = Fixture::new(0, 0);
    let id0 = open_claim(&f);
    let id2 = open_claim(&f);
    // id1=999 and id3=1000 are not real claim ids.

    let result = f
        .client()
        .batch_get_claims(&ids(&f, &[id0, 999, id2, 1000]))
        .unwrap();

    assert_eq!(result.len(), 4);
    assert!(result.get(0).unwrap().is_some(), "slot 0 (existing) should be Some");
    assert!(result.get(1).unwrap().is_none(), "slot 1 (missing) should be None");
    assert!(result.get(2).unwrap().is_some(), "slot 2 (existing) should be Some");
    assert!(result.get(3).unwrap().is_none(), "slot 3 (missing) should be None");
}

// ── negative ─────────────────────────────────────────────────────────────────

#[test]
fn all_missing_ids_return_all_nones() {
    let f = Fixture::new(0, 0);

    let result = f.client().batch_get_claims(&ids(&f, &[100, 200, 300])).unwrap();
    assert_eq!(result.len(), 3);
    for i in 0..3u32 {
        assert!(result.get(i).unwrap().is_none(), "slot {i} should be None for missing id");
    }
}

#[test]
fn batch_too_large_returns_claim_batch_too_large_error() {
    use crate::types::Error;

    let f = Fixture::new(0, 0);

    // Build a slice of MAX_BATCH_CLAIMS + 1 (non-existent) ids.
    let mut oversized: Vec<u64> = Vec::new(&f.env);
    for i in 0..=(MAX_BATCH_CLAIMS as u64) {
        oversized.push_back(i + 1_000_000);
    }
    assert_eq!(oversized.len(), MAX_BATCH_CLAIMS + 1);

    let err = f.client().try_batch_get_claims(&oversized).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimBatchTooLarge);
}

// ── boundary ─────────────────────────────────────────────────────────────────

#[test]
fn empty_input_returns_empty_result() {
    let f = Fixture::new(0, 0);

    let empty: Vec<u64> = Vec::new(&f.env);
    let result = f.client().batch_get_claims(&empty).unwrap();
    assert_eq!(result.len(), 0, "empty input must produce empty output");
}

#[test]
fn exactly_max_batch_claims_ids_is_accepted() {
    let f = Fixture::new(0, 0);

    // Use non-existent ids — we only need to confirm the call succeeds.
    let mut max_ids: Vec<u64> = Vec::new(&f.env);
    for i in 0..(MAX_BATCH_CLAIMS as u64) {
        max_ids.push_back(i + 1_000_000);
    }
    assert_eq!(max_ids.len(), MAX_BATCH_CLAIMS);

    // Should succeed (return all Nones for non-existent ids).
    let result = f.client().batch_get_claims(&max_ids).unwrap();
    assert_eq!(result.len(), MAX_BATCH_CLAIMS);
    for i in 0..MAX_BATCH_CLAIMS {
        assert!(result.get(i).unwrap().is_none());
    }
}

#[test]
fn one_over_max_batch_claims_is_rejected() {
    use crate::types::Error;

    let f = Fixture::new(0, 0);
    let mut oversized: Vec<u64> = Vec::new(&f.env);
    for i in 0..=(MAX_BATCH_CLAIMS as u64) {
        oversized.push_back(i + 2_000_000);
    }
    let err = f.client().try_batch_get_claims(&oversized).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimBatchTooLarge);
}

#[test]
fn single_id_boundary_existing() {
    let f = Fixture::new(0, 0);
    let id = open_claim(&f);
    let result = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    assert_eq!(result.len(), 1);
    assert!(result.get(0).unwrap().is_some());
}

#[test]
fn single_id_boundary_missing() {
    let f = Fixture::new(0, 0);
    let result = f.client().batch_get_claims(&ids(&f, &[9_999])).unwrap();
    assert_eq!(result.len(), 1);
    assert!(result.get(0).unwrap().is_none());
}

#[test]
fn two_ids_boundary() {
    let f = Fixture::new(0, 0);
    let id = open_claim(&f);
    let result = f.client().batch_get_claims(&ids(&f, &[id, 9_999])).unwrap();
    assert_eq!(result.len(), 2);
    assert!(result.get(0).unwrap().is_some());
    assert!(result.get(1).unwrap().is_none());
}

// ── positional correctness ────────────────────────────────────────────────────

#[test]
fn result_order_matches_input_order() {
    let f = Fixture::new(0, 0);
    let id0 = open_claim(&f);
    let id1 = open_claim(&f);
    let id2 = open_claim(&f);

    // Request in reverse order; result must also be in that order.
    let result = f.client().batch_get_claims(&ids(&f, &[id2, id1, id0])).unwrap();
    assert_eq!(result.len(), 3);

    let c0 = result.get(0).unwrap().unwrap();
    let c1 = result.get(1).unwrap().unwrap();
    let c2 = result.get(2).unwrap().unwrap();

    // Confirm identities by reading via the single accessor.
    let single0 = f.client().get_claim(&id2);
    let single1 = f.client().get_claim(&id1);
    let single2 = f.client().get_claim(&id0);

    assert_eq!(c0.question, single0.question, "slot 0 should be claim {id2}");
    assert_eq!(c1.question, single1.question, "slot 1 should be claim {id1}");
    assert_eq!(c2.question, single2.question, "slot 2 should be claim {id0}");
}

#[test]
fn duplicate_ids_each_return_some_independently() {
    let f = Fixture::new(0, 0);
    let id = open_claim(&f);

    // Request the same id twice; both slots should be Some.
    let result = f.client().batch_get_claims(&ids(&f, &[id, id])).unwrap();
    assert_eq!(result.len(), 2);
    assert!(result.get(0).unwrap().is_some(), "first occurrence should be Some");
    assert!(result.get(1).unwrap().is_some(), "second occurrence should be Some");
}

// ── conservation: no money movement ──────────────────────────────────────────

#[test]
fn batch_read_does_not_change_escrow_balance() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let before = f.escrow_balance();

    let result = f.client().batch_get_claims(&ids(&f, &[id, 9_999])).unwrap();
    assert_eq!(result.len(), 2);

    let after = f.escrow_balance();
    assert_eq!(before, after, "batch_get_claims must not move any funds");
}

// ── state machine: all ClaimState variants ────────────────────────────────────

#[test]
fn open_claim_is_returned_correctly() {
    let f = Fixture::new(0, 0);
    let id = open_claim(&f);

    let result = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    let claim = result.get(0).unwrap().unwrap();
    assert_eq!(claim.state, ClaimState::Open);
}

#[test]
fn active_claim_is_returned_correctly() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let challenger = f.user(10 * USDC);
    f.client().challenge_claim(&challenger, &id, &(2 * USDC), &None);

    let result = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    let claim = result.get(0).unwrap().unwrap();
    assert_eq!(claim.state, ClaimState::Active);
}

#[test]
fn resolved_claim_is_returned_correctly() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let challenger = f.user(10 * USDC);
    f.client().challenge_claim(&challenger, &id, &(2 * USDC), &None);

    // Advance past deadline and resolve.
    f.env.ledger().with_mut(|li| li.timestamp += 3_700);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator wins"),
        &80,
        &f.zero_hash(),
    );

    let result = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    let claim = result.get(0).unwrap().unwrap();
    assert_eq!(claim.state, ClaimState::Resolved);
    assert_eq!(claim.winner_side, WinnerSide::Creator);
}

#[test]
fn cancelled_claim_is_returned_correctly() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    // Advance past deadline (no challenger → can cancel).
    f.env.ledger().with_mut(|li| li.timestamp += 3_700);
    f.client().cancel_claim(&id);

    let result = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    let claim = result.get(0).unwrap().unwrap();
    assert_eq!(claim.state, ClaimState::Cancelled);
}

// ── regression: field-by-field agreement with get_claim ───────────────────────

#[test]
fn batch_result_matches_single_get_claim_on_every_field() {
    let f = Fixture::new(50, 50);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let single = f.client().get_claim(&id);
    let batch = f.client().batch_get_claims(&ids(&f, &[id])).unwrap();
    let from_batch = batch.get(0).unwrap().unwrap();

    // All scalar and structural fields must be identical.
    assert_eq!(from_batch.creator,                 single.creator);
    assert_eq!(from_batch.question,                single.question);
    assert_eq!(from_batch.creator_position,        single.creator_position);
    assert_eq!(from_batch.counter_position,        single.counter_position);
    assert_eq!(from_batch.resolution_url,          single.resolution_url);
    assert_eq!(from_batch.creator_stake,           single.creator_stake);
    assert_eq!(from_batch.total_challenger_stake,  single.total_challenger_stake);
    assert_eq!(from_batch.reserved_creator_liability, single.reserved_creator_liability);
    assert_eq!(from_batch.deadline,                single.deadline);
    assert_eq!(from_batch.state,                   single.state);
    assert_eq!(from_batch.winner_side,             single.winner_side);
    assert_eq!(from_batch.confidence,              single.confidence);
    assert_eq!(from_batch.category,                single.category);
    assert_eq!(from_batch.parent_id,               single.parent_id);
    assert_eq!(from_batch.challenger_count,        single.challenger_count);
    assert_eq!(from_batch.remaining_escrow,        single.remaining_escrow);
    assert_eq!(from_batch.challenger_claims,       single.challenger_claims);
    assert_eq!(from_batch.created_at,              single.created_at);
    assert_eq!(from_batch.evidence_hash,           single.evidence_hash);
    assert_eq!(from_batch.context_hash,            single.context_hash);
    assert_eq!(from_batch.fees.platform_fee_bps,   single.fees.platform_fee_bps);
    assert_eq!(from_batch.fees.agent_owner_fee_bps, single.fees.agent_owner_fee_bps);
}

#[test]
fn batch_with_gaps_each_present_slot_matches_single_get_claim() {
    let f = Fixture::new(0, 0);
    let id0 = open_claim(&f);
    let id1 = open_claim(&f);

    // Leave a gap with a missing id in between.
    let batch = f
        .client()
        .batch_get_claims(&ids(&f, &[id0, 999_999, id1]))
        .unwrap();

    let s0 = f.client().get_claim(&id0);
    let s1 = f.client().get_claim(&id1);

    let b0 = batch.get(0).unwrap().unwrap();
    let b1 = batch.get(2).unwrap().unwrap();

    assert_eq!(b0.created_at, s0.created_at, "slot 0 must match claim {id0}");
    assert_eq!(b0.creator_stake, s0.creator_stake);
    assert_eq!(b1.created_at, s1.created_at, "slot 2 must match claim {id1}");
    assert_eq!(b1.creator_stake, s1.creator_stake);

    assert!(batch.get(1).unwrap().is_none(), "slot 1 (missing id) must be None");
}
