"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { createApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/lib/toast";

interface PreviewQuestion {
  id: string;
  challenge_id: string;
  round: 1 | 2 | 3;
  question_type: string;
  prompt_type: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: "A" | "B" | "C" | "D";
  approved: boolean | null;
}

interface BrandInfo {
  id: string;
  name: string;
  logo_url: string | null;
  tagline: string | null;
}

export default function QuestionPreviewPage() {
  const { data: session, status } = useSession();
  const params = useParams();
  const router = useRouter();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const brandId = params.id as string;

  const [brand, setBrand] = useState<BrandInfo | null>(null);
  const [questions, setQuestions] = useState<PreviewQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const loadData = useCallback(async () => {
    if (!apiToken) return;
    setLoading(true);
    try {
      const api = createApiClient(apiToken);
      const [brandRes, previewRes] = await Promise.all([
        api.get(`/brands/${brandId}`),
        api.get(`/brands/${brandId}/questions/preview`),
      ]);
      setBrand(brandRes.data.brand);
      setQuestions(previewRes.data.questions ?? []);
    } catch {
      toast.error("Failed to load questions. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [apiToken, brandId]);

  useEffect(() => {
    if (status === "authenticated") void loadData();
  }, [loadData, status]);

  const handleApprove = async () => {
    if (!apiToken || !questions[currentIndex]) return;
    setApproving(true);
    try {
      const api = createApiClient(apiToken);
      await api.post(`/brands/${brandId}/questions/${questions[currentIndex].id}/approve`);
      setQuestions((prev) =>
        prev.map((q, i) => (i === currentIndex ? { ...q, approved: true } : q))
      );
      toast.success("Question approved!");
    } catch {
      toast.error("Failed to approve question.");
    } finally {
      setApproving(false);
    }
  };

  const handleFlag = async () => {
    if (!apiToken || !questions[currentIndex]) return;
    setRegenerating(true);
    try {
      const api = createApiClient(apiToken);
      const res = await api.post(
        `/brands/${brandId}/questions/${questions[currentIndex].id}/regenerate`
      );
      const newQuestion = res.data.question;
      setQuestions((prev) =>
        prev.map((q, i) => (i === currentIndex ? { ...newQuestion } : q))
      );
      toast.success("Question regenerated!");
    } catch {
      toast.error("Failed to regenerate question.");
    } finally {
      setRegenerating(false);
    }
  };

  if (status === "loading" || loading) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <div className="flex gap-3">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-24" />
        </div>
      </main>
    );
  }

  if (!brand) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-[var(--muted-foreground)]">Brand not found.</p>
      </main>
    );
  }

  const question = questions[currentIndex];
  const reviewedCount = questions.filter((q) => q.approved !== null).length;
  const allApproved = questions.length > 0 && questions.every((q) => q.approved === true);
  const progressPercent = questions.length > 0 ? (reviewedCount / questions.length) * 100 : 0;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {brand.logo_url ? (
            <Image
              src={brand.logo_url}
              alt={brand.name}
              width={48}
              height={48}
              className="h-12 w-12 rounded-lg object-contain"
            />
          ) : (
            <div className="h-12 w-12 rounded-lg bg-[var(--primary)]" />
          )}
          <div>
            <h1 className="text-2xl font-bold">{brand.name}</h1>
            <p className="text-sm text-[var(--muted-foreground)]">Question Preview</p>
          </div>
        </div>
        <Link href={`/brand/${brandId}`}>
          <Button variant="outline" size="sm">
            Back to Brand
          </Button>
        </Link>
      </div>

      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-[var(--muted-foreground)]">
            {reviewedCount} of {questions.length} reviewed
          </span>
          <span className="text-[var(--muted-foreground)]">
            {allApproved ? "All approved" : "Pending review"}
          </span>
        </div>
        <Progress value={progressPercent} />
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[var(--muted-foreground)]">
              No questions found. Create a challenge first to generate questions.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Round {question.round} of 3</CardTitle>
                <Badge
                  variant={
                    question.approved === true
                      ? "default"
                      : question.approved === false
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {question.approved === true
                    ? "Approved"
                    : question.approved === false
                    ? "Flagged"
                    : "Pending"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-center text-lg font-semibold">{question.question_text}</p>

              <div className="grid grid-cols-1 gap-2">
                {(["A", "B", "C", "D"] as const).map((opt) => {
                  const key = `option_${opt.toLowerCase()}` as keyof PreviewQuestion;
                  const text = question[key] as string;
                  const isCorrect = opt === question.correct_option;
                  return (
                    <div
                      key={opt}
                      className={`rounded-lg border px-4 py-3 text-sm ${
                        isCorrect
                          ? "border-green-500 bg-green-50 text-green-900"
                          : "border-[var(--border)]"
                      }`}
                    >
                      <span className="mr-2 font-bold">{opt}.</span>
                      {text}
                      {isCorrect && (
                        <Badge variant="default" className="ml-2">
                          Correct
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((i) => i - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-[var(--muted-foreground)]">
              {currentIndex + 1} / {questions.length}
            </span>
            <Button
              variant="outline"
              disabled={currentIndex === questions.length - 1}
              onClick={() => setCurrentIndex((i) => i + 1)}
            >
              Next
            </Button>
          </div>

          <div className="mt-6 flex gap-3">
            <Button
              onClick={handleApprove}
              disabled={approving || question.approved === true}
              className="flex-1"
            >
              {question.approved === true ? "Approved" : approving ? "Approving..." : "Approve"}
            </Button>
            <Button
              variant="outline"
              onClick={handleFlag}
              disabled={regenerating}
              className="flex-1"
            >
              {regenerating ? "Regenerating..." : "Flag for Regeneration"}
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
