import { getInput, debug, setFailed } from "@actions/core";
import { getOctokit, context } from "@actions/github";

const GITHUB_ACTIONS_BOT = "github-actions[bot]";

const repoToken = getInput("repo-token", { required: true });
const titleRegex: RegExp = new RegExp(
  getInput("title-regex", {
    required: true,
  }),
);
const onFailedRegexFailAction: boolean =
  getInput("on-failed-regex-fail-action") === "true";
const onFailedRegexCreateReview: boolean =
  getInput("on-failed-regex-create-review") === "true";
const onFailedRegexRequestChanges: boolean =
  getInput("on-failed-regex-request-changes") === "true";
const onFailedRegexComment: string = getInput("on-failed-regex-comment");
const onSucceededRegexDismissReviewComment: string = getInput(
  "on-succeeded-regex-dismiss-review-comment",
);
const onSucceededRegexMinimizeComment: boolean =
  getInput("on-succeeded-regex-minimize-comment") === "true";
const onMinimizeCommentReason: string = getInput("on-minimize-comment-reason") || "RESOLVED";

const octokit = getOctokit(repoToken);

export async function run(): Promise<void> {
  const githubContext = context;
  const pullRequest = githubContext.issue;

  const title: string =
    (githubContext.payload.pull_request?.title as string) ?? "";
  const comment = onFailedRegexComment.replace("%regex%", titleRegex.source);

  debug(`Title Regex: ${titleRegex.source}`);
  debug(`Title: ${title}`);

  const titleMatchesRegex: boolean = titleRegex.test(title);
  if (!titleMatchesRegex) {
    if (onFailedRegexCreateReview) {
      await createOrUpdateReview(comment, pullRequest);
    }
    if (onFailedRegexFailAction) {
      setFailed(comment);
    }
  } else {
    if (onFailedRegexCreateReview) {
      // Title is now valid, dismiss any existing review
      console.log(`PR title matches regex, dismissing any existing reviews`);
      await dismissReview(pullRequest);

      if (onSucceededRegexMinimizeComment) {
        console.log(`Minimize review`);
        await minimizeReview(pullRequest);
      }
    }
  }
}

const createOrUpdateReview = async (
  comment: string,
  pullRequest: { owner: string; repo: string; number: number },
) => {
  const review = await getReview(pullRequest);

  if (review === undefined) {
    await octokit.rest.pulls.createReview({
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      pull_number: pullRequest.number,
      body: comment,
      event: onFailedRegexRequestChanges ? "REQUEST_CHANGES" : "COMMENT",
    });
  } else {
    await octokit.rest.pulls.updateReview({
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      pull_number: pullRequest.number,
      review_id: review.id,
      body: comment,
    });
  }
};

// Check if a user is a GitHub Actions bot
const isGitHubActionUser = (login: string): boolean => {
  return login === GITHUB_ACTIONS_BOT;
};

// Get the existing review created by GitHub Actions bot
const getReview = async (pullRequest: {
  owner: string;
  repo: string;
  number: number;
}): Promise<{ id: number; state: string } | undefined> => {
  const reviews = await octokit.rest.pulls.listReviews({
    owner: pullRequest.owner,
    repo: pullRequest.repo,
    pull_number: pullRequest.number,
  });

  return reviews.data.find(
    (review) => review.user && isGitHubActionUser(review.user.login),
  );
};

// Dismiss an existing review
const dismissReview = async (pullRequest: {
  owner: string;
  repo: string;
  number: number;
}): Promise<void> => {
  const review = await getReview(pullRequest);
  if (review) {
    console.log(`Found existing review with ID: ${review.id}, state: ${review.state}`);

    // Can only dismiss reviews with state APPROVED or CHANGES_REQUESTED
    // See: https://docs.github.com/en/rest/pulls/reviews#dismiss-a-review-for-a-pull-request
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      console.log(`Dismissing review with ID: ${review.id}`);
      try {
        await octokit.rest.pulls.dismissReview({
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          pull_number: pullRequest.number,
          review_id: review.id,
          message: onSucceededRegexDismissReviewComment,
        });
        console.log(`Successfully dismissed review with ID: ${review.id}`);
      } catch (error) {
        console.log(`Error dismissing review: ${error instanceof Error ? error.message : String(error)}`);

        // Create a new review comment to indicate the title now matches
        try {
          console.log(`Creating a new comment since review can't be dismissed`);
          await octokit.rest.pulls.createReview({
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pull_number: pullRequest.number,
            body: onSucceededRegexDismissReviewComment,
            event: "COMMENT",
          });
        } catch (commentError) {
          console.log(`Error creating comment: ${commentError instanceof Error ? commentError.message : String(commentError)}`);
        }
      }
    } else {
      // For COMMENTED state, we can't dismiss the review, so just add a new comment
      console.log(`Review state is ${review.state}, creating a new comment instead of dismissing`);
      await octokit.rest.pulls.createReview({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        pull_number: pullRequest.number,
        body: onSucceededRegexDismissReviewComment,
        event: "COMMENT",
      });
    }
  } else {
    console.log(`No review found to dismiss for PR #${pullRequest.number}`);
  }
};

// Get a review's global node ID using GraphQL
const getReviewNodeId = async (
  reviewDatabaseId: number,
  pullRequest: {
    owner: string;
    repo: string;
    number: number;
  }
) => {
  try {
    const { repository } = await octokit.graphql<{
      repository: {
        pullRequest: {
          reviews: {
            nodes: Array<{ id: string; databaseId: number }>;
          };
        };
      };
    }>(`
      query GetReviewNodeId($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviews(first: 100) {
              nodes {
                id
                databaseId
              }
            }
          }
        }
      }
    `, {
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
    });

    const pullRequestObj = repository?.pullRequest;
    if (!pullRequestObj) {
      console.log(`No PR found for number ${pullRequest.number}`);
      return null;
    }

    const review = pullRequestObj.reviews.nodes.find(node => node.databaseId === reviewDatabaseId);

    if (review) {
      console.log(`Found review with node ID: ${review.id}`);
      return review.id;
    }

    console.log(`No reviews found with database ID: ${reviewDatabaseId}`);
    return null;
  } catch (error) {
    console.log(`Error fetching review node ID: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

// Minimize the review created by the bot
const minimizeReview = async (pullRequest: {
  owner: string;
  repo: string;
  number: number;
}) => {
  console.log(`Minimizing existing content on PR #${pullRequest.number}`);

  const review = await getReview(pullRequest);
  if (review) {
    console.log(`Found existing review with ID: ${review.id}`);
    const reviewNodeId = await getReviewNodeId(review.id, pullRequest);
    if (reviewNodeId) {
      await minimizeReviewById(reviewNodeId, pullRequest);
    }
  } else {
    console.log('No existing reviews found to minimize');
  }
};

// Use GitHub GraphQL API to minimize a review
// (reviews are also comments from GraphQL's perspective)
const minimizeReviewById = async (
  reviewNodeId: string,
  pullRequest: {
    owner: string;
    repo: string;
    number: number;
  }
) => {
  try {
    console.log(`Minimizing review with node ID: ${reviewNodeId}`);
    // PullRequestReview implements Minimizable interface, so we can use minimizeComment mutation
    await octokit.graphql<{
      minimizeComment: {
        minimizedComment: {
          isMinimized: boolean;
          minimizedReason: string;
        };
      };
    }>(`
      mutation MinimizeComment($input: MinimizeCommentInput!) {
        minimizeComment(input: $input) {
          minimizedComment {
            isMinimized
            minimizedReason
          }
        }
      }
    `, {
      input: {
        subjectId: reviewNodeId,
        classifier: onMinimizeCommentReason,
        clientMutationId: `pr-lint-action-review-${pullRequest.number}-${Date.now()}`,
      },
    });

    console.log(`Review minimized successfully`);
  } catch (error) {
    console.log(`Failed to minimize review: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.log(`Stack trace: ${error.stack}`);
    }

    // Fallback to dismissing the review if minimizing fails
    try {
      console.log(`Falling back to dismissing the review`);
      const review = await getReview(pullRequest);
      if (review) {
        await octokit.rest.pulls.dismissReview({
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          pull_number: pullRequest.number,
          review_id: review.id,
          message: onSucceededRegexDismissReviewComment,
        });
        console.log(`Review dismissed successfully as fallback`);
      }
    } catch (fallbackError) {
      console.log(`Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  }
};
